/**
 * Pure spec -> catalogue transformation.
 *
 * Kept separate from build-spec.ts (which does file I/O and reporting) so that the parts most
 * likely to break silently — $ref expansion through recursive DTOs, tool-name derivation and
 * collision handling, and the catalogue diff — are directly unit-testable.
 */

export type Json = Record<string, any>;

export const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
export const MAX_TOOL_NAME = 64;

export interface OperationRecord {
  name: string;
  operationId: string;
  method: string;
  path: string;
  controller: string;
  controllerSlug: string;
  summary: string;
  description: string;
  pathParams: string[];
  queryParams: string[];
  hasBody: boolean;
  bodyRequired: boolean;
  mutating: boolean;
  destructive: boolean;
  adminJwtOnly: boolean;
  schemaBytes: number;
  inputSchema: Json;
}

export interface Catalogue {
  apiTitle: string;
  apiVersion: string;
  openapi: string;
  operationCount: number;
  controllers: { name: string; slug: string; count: number }[];
  operations: OperationRecord[];
}

/**
 * Inlines every `$ref` under `node`.
 *
 * Remnawave's DTOs are recursive in a few places (config profile inbounds, Xray config
 * fragments). `stack` carries the chain of schema names currently being expanded; when a name
 * repeats we stop and emit a permissive placeholder instead of looping forever.
 */
export function dereference(node: unknown, schemas: Json, stack: string[] = []): any {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => dereference(n, schemas, stack));

  const obj = node as Json;
  if (typeof obj.$ref === "string") {
    const name = obj.$ref.replace("#/components/schemas/", "");
    if (stack.includes(name)) {
      return {
        type: "object",
        additionalProperties: true,
        description: `Recursive reference to ${name} — pass a raw JSON object of the same shape.`,
      };
    }
    const target = schemas[name];
    if (!target) {
      return { description: `Unresolved reference ${obj.$ref}`, additionalProperties: true };
    }
    const expanded = dereference(target, schemas, [...stack, name]);
    const { $ref, ...siblings } = obj;
    return Object.keys(siblings).length ? { ...expanded, ...siblings } : expanded;
  }

  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) out[k] = dereference(v, schemas, stack);
  return out;
}

export function pathSlug(path: string): string {
  return path
    .replace(/^\/api\//, "")
    .replace(/^\//, "")
    .replace(/\{([^}]+)\}/g, "$1") // {userId} -> userId
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // userId -> user_Id
    .replace(/[/-]/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

/**
 * `remnawave_<method>_<path slug>`, shortened deterministically when it would exceed the
 * 64-character tool-name budget several MCP hosts enforce. Shortening drops path-parameter
 * words (the least informative part of the name) from left to right.
 */
export function toolName(method: string, path: string, pathParams: string[]): string {
  let name = `remnawave_${method}_${pathSlug(path)}`;
  if (name.length <= MAX_TOOL_NAME) return name;

  for (const p of pathParams) {
    const word = pathSlug(p);
    name = name.replace(new RegExp(`_${word}(?=_|$)`), "");
    if (name.length <= MAX_TOOL_NAME) return name;
  }
  return name.slice(0, MAX_TOOL_NAME).replace(/_+$/, "");
}

export function controllerSlug(tag: string): string {
  const isPublic = tag.startsWith("[Public]");
  const base = tag
    .replace(/^\[(Public|Protected)\]\s*/, "")
    .replace(/\s*Controller$/, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return isPublic ? `public-${base}` : base;
}

/**
 * Paths that change or destroy a lot of state at once. They get `destructiveHint` and, at
 * runtime, an explicit `confirm: true` gate.
 */
export function isDestructivePath(path: string): boolean {
  return (
    /\/bulk(\/|$)/.test(path) ||
    /\/bulk-actions(\/|$)/.test(path) ||
    /delete-all/.test(path) ||
    /truncate/.test(path) ||
    /restart-all/.test(path)
  );
}

/**
 * Some endpoints are served only to a logged-in admin (JWT), never to an API token. The panel
 * says so in prose; the auth and passkey controllers are session machinery by nature. Marking
 * them lets the server refuse locally instead of sending a request that cannot succeed.
 */
export function isAdminJwtOnly(op: Json, slug: string): boolean {
  if (slug === "auth" || slug === "passkeys") return true;
  const text = `${op.description ?? ""} ${op.summary ?? ""}`;
  return /forbidden\s+(to\s+use\s+)?via\s+"?API-key/i.test(text) || /admin\s+JWT/i.test(text);
}

export function extractPathParams(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
}

/** Turns a parsed OpenAPI document into the catalogue the server ships. */
export function buildCatalogue(spec: Json): Catalogue {
  const schemas: Json = spec.components?.schemas ?? {};
  const operations: OperationRecord[] = [];
  const seenNames = new Set<string>();

  for (const [path, methodsRaw] of Object.entries(spec.paths ?? {})) {
    for (const [method, opRaw] of Object.entries(methodsRaw as Json)) {
      if (!(HTTP_METHODS as readonly string[]).includes(method)) continue;
      const op = opRaw as Json;

      const pathParams = extractPathParams(path);
      const params: Json[] = Array.isArray(op.parameters)
        ? (dereference(op.parameters, schemas) as Json[])
        : [];
      const queryParams = params.filter((p) => p.in === "query").map((p) => p.name as string);

      const properties: Json = {};
      const required: string[] = [];

      for (const p of params) {
        if (p.in !== "path" && p.in !== "query") continue;
        properties[p.name] = {
          ...(p.schema ?? { type: "string" }),
          ...(p.description ? { description: p.description } : {}),
        };
        if (p.in === "path" || p.required) required.push(p.name);
      }
      // Path placeholders the spec forgot to declare are still mandatory.
      for (const pp of pathParams) {
        if (!properties[pp]) {
          properties[pp] = { type: "string", description: `Path parameter '${pp}'.` };
          required.push(pp);
        }
      }

      const bodyRef = op.requestBody?.content?.["application/json"]?.schema;
      const hasBody = Boolean(bodyRef);
      if (hasBody) {
        const bodySchema = dereference(bodyRef, schemas);
        properties.body = {
          ...bodySchema,
          description: bodySchema.description ?? `Request body for ${method.toUpperCase()} ${path}.`,
        };
        if (op.requestBody?.required) required.push("body");
      }

      const controller: string = op.tags?.[0] ?? "Other";
      const slug = controllerSlug(controller);
      const name = toolName(method, path, pathParams);
      if (seenNames.has(name)) {
        throw new Error(`Duplicate tool name '${name}' (${method.toUpperCase()} ${path})`);
      }
      seenNames.add(name);

      const inputSchema: Json = {
        type: "object",
        properties,
        ...(required.length ? { required: [...new Set(required)] } : {}),
        additionalProperties: false,
      };

      operations.push({
        name,
        operationId: op.operationId ?? name,
        method,
        path,
        controller,
        controllerSlug: slug,
        summary: op.summary ?? "",
        description:
          [op.summary, op.description].filter(Boolean).join(" — ") ||
          `${method.toUpperCase()} ${path}`,
        pathParams,
        queryParams,
        hasBody,
        bodyRequired: Boolean(op.requestBody?.required),
        mutating: method !== "get",
        destructive: method === "delete" || isDestructivePath(path),
        adminJwtOnly: isAdminJwtOnly(op, slug),
        schemaBytes: JSON.stringify(inputSchema).length,
        inputSchema,
      });
    }
  }

  operations.sort((a, b) => a.name.localeCompare(b.name));

  const byController = new Map<string, { name: string; slug: string; count: number }>();
  for (const op of operations) {
    const entry = byController.get(op.controllerSlug) ?? {
      name: op.controller,
      slug: op.controllerSlug,
      count: 0,
    };
    entry.count += 1;
    byController.set(op.controllerSlug, entry);
  }

  return {
    apiTitle: spec.info?.title ?? "Remnawave API",
    apiVersion: spec.info?.version ?? "unknown",
    openapi: spec.openapi ?? "3.0.0",
    operationCount: operations.length,
    controllers: [...byController.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    operations,
  };
}

export interface CatalogueDiff {
  added: string[];
  removed: string[];
  renamed: string[];
  reshaped: string[];
  versionChanged: boolean;
  breaking: boolean;
}

type DiffableOperation = Pick<OperationRecord, "name" | "method" | "path" | "schemaBytes">;
type DiffableCatalogue = { apiVersion: string; operations: DiffableOperation[] };

/**
 * Compares two catalogues.
 *
 * The failure mode that matters is a tool quietly disappearing: an MCP client that referenced
 * it just starts erroring, and a plain rebuild would say nothing. An operation whose route
 * survives but whose derived name changed is reported as a rename, not as add + remove.
 */
export function diffCatalogues(
  previous: DiffableCatalogue,
  next: DiffableCatalogue
): CatalogueDiff {
  const prevByName = new Map(previous.operations.map((o) => [o.name, o]));
  const prevByRoute = new Map(previous.operations.map((o) => [`${o.method} ${o.path}`, o]));
  const nextByName = new Map(next.operations.map((o) => [o.name, o]));
  const nextByRoute = new Map(next.operations.map((o) => [`${o.method} ${o.path}`, o]));

  const added: string[] = [];
  const renamed: string[] = [];
  for (const op of next.operations) {
    if (prevByName.has(op.name)) continue;
    const sameRoute = prevByRoute.get(`${op.method} ${op.path}`);
    if (sameRoute) renamed.push(`${sameRoute.name} -> ${op.name}`);
    else added.push(`${op.name}  (${op.method.toUpperCase()} ${op.path})`);
  }

  const removed: string[] = [];
  for (const op of previous.operations) {
    if (nextByName.has(op.name)) continue;
    if (nextByRoute.has(`${op.method} ${op.path}`)) continue; // reported as a rename
    removed.push(`${op.name}  (${op.method.toUpperCase()} ${op.path})`);
  }

  const reshaped: string[] = [];
  for (const op of next.operations) {
    const before = prevByName.get(op.name);
    if (!before) continue;
    if (Math.abs(op.schemaBytes - before.schemaBytes) > 64) {
      reshaped.push(`${op.name}  ${before.schemaBytes} -> ${op.schemaBytes} B`);
    }
  }

  return {
    added,
    removed,
    renamed,
    reshaped,
    versionChanged: previous.apiVersion !== next.apiVersion,
    breaking: removed.length > 0 || renamed.length > 0,
  };
}
