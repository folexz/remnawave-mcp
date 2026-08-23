/**
 * build-spec — turns the raw Remnawave OpenAPI document into the compact, runtime-ready
 * operation catalogue that ships with the package.
 *
 *   spec/remnawave-openapi.json   (input, ~1.5 MB, repo only — not published to npm)
 *        |
 *        v
 *   spec/remnawave-operations.json (output, ~250 KB, published)
 *
 * What it does:
 *   - walks every path/method pair and produces one operation record;
 *   - fully dereferences `$ref`s into the request-body schema (with cycle protection),
 *     because an MCP client cannot resolve `#/components/schemas/...` on its own;
 *   - merges path/query parameters and the request body into a single JSON Schema
 *     that is used verbatim as a tool's `inputSchema`;
 *   - derives a stable, unique, <= 64 character tool name per operation;
 *   - groups operations by controller (OpenAPI tag) so the server can expose them in tiers.
 *
 * Regenerate after dropping in a newer spec:  npm run build-spec
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const IN_PATH = join(ROOT, "spec", "remnawave-openapi.json");
const OUT_PATH = join(ROOT, "spec", "remnawave-operations.json");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

type Json = Record<string, any>;

/* ------------------------------------------------------------------ $ref resolution */

/**
 * Inlines every `$ref` under `node`.
 *
 * Remnawave's DTOs are recursive in a few places (config profile inbounds, Xray config
 * fragments). `stack` carries the chain of schema names currently being expanded; when a
 * name repeats we stop and emit a permissive placeholder instead of looping forever.
 */
function dereference(node: unknown, schemas: Json, stack: string[]): any {
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
    if (!target) return { description: `Unresolved reference ${obj.$ref}`, additionalProperties: true };
    const expanded = dereference(target, schemas, [...stack, name]);
    // Keep any sibling keywords (description/default) that sat next to the $ref.
    const { $ref, ...siblings } = obj;
    return Object.keys(siblings).length ? { ...expanded, ...siblings } : expanded;
  }

  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) out[k] = dereference(v, schemas, stack);
  return out;
}

/* ------------------------------------------------------------------ naming */

function pathSlug(path: string): string {
  return path
    .replace(/^\/api\//, "")
    .replace(/^\//, "")
    .replace(/\{([^}]+)\}/g, "$1") // {userId} -> userId
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2") // userId -> user_Id
    .replace(/[/-]/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .replace(/_+/g, "_")
    .toLowerCase();
}

const MAX_TOOL_NAME = 64;

/**
 * `remnawave_<method>_<path slug>`, shortened deterministically when it would exceed the
 * 64-character tool-name budget that several MCP hosts enforce. Shortening drops path
 * parameter words (the least informative part of the name) from left to right.
 */
function toolName(method: string, path: string, pathParams: string[]): string {
  let name = `remnawave_${method}_${pathSlug(path)}`;
  if (name.length <= MAX_TOOL_NAME) return name;

  for (const p of pathParams) {
    const word = pathSlug(p);
    name = name.replace(new RegExp(`_${word}(?=_|$)`), "");
    if (name.length <= MAX_TOOL_NAME) return name;
  }
  return name.slice(0, MAX_TOOL_NAME).replace(/_+$/, "");
}

function controllerSlug(tag: string): string {
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

/* ------------------------------------------------------------------ main */

interface OperationRecord {
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
  schemaBytes: number;
  inputSchema: Json;
}

function build(): void {
  const spec = JSON.parse(readFileSync(IN_PATH, "utf8")) as Json;
  const schemas: Json = spec.components?.schemas ?? {};
  const operations: OperationRecord[] = [];
  const seenNames = new Set<string>();

  for (const [path, methodsRaw] of Object.entries(spec.paths ?? {})) {
    for (const [method, opRaw] of Object.entries(methodsRaw as Json)) {
      if (!(HTTP_METHODS as readonly string[]).includes(method)) continue;
      const op = opRaw as Json;

      const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const params: Json[] = Array.isArray(op.parameters)
        ? (dereference(op.parameters, schemas, []) as Json[])
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
      // Path placeholders that the spec forgot to declare are still mandatory.
      for (const pp of pathParams) {
        if (!properties[pp]) {
          properties[pp] = { type: "string", description: `Path parameter '${pp}'.` };
          required.push(pp);
        }
      }

      const bodyRef = op.requestBody?.content?.["application/json"]?.schema;
      const hasBody = Boolean(bodyRef);
      if (hasBody) {
        const bodySchema = dereference(bodyRef, schemas, []);
        properties.body = {
          ...bodySchema,
          description: bodySchema.description ?? `Request body for ${method.toUpperCase()} ${path}.`,
        };
        if (op.requestBody?.required) required.push("body");
      }

      const mutating = method !== "get";
      const controller: string = op.tags?.[0] ?? "Other";
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
        controllerSlug: controllerSlug(controller),
        summary: op.summary ?? "",
        description:
          [op.summary, op.description].filter(Boolean).join(" — ") ||
          `${method.toUpperCase()} ${path}`,
        pathParams,
        queryParams,
        hasBody,
        bodyRequired: Boolean(op.requestBody?.required),
        mutating,
        destructive: method === "delete" || isDestructivePath(path),
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

  const artifact = {
    apiTitle: spec.info?.title ?? "Remnawave API",
    apiVersion: spec.info?.version ?? "unknown",
    openapi: spec.openapi ?? "3.0.0",
    operationCount: operations.length,
    controllers: [...byController.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    operations,
  };

  writeFileSync(OUT_PATH, JSON.stringify(artifact, null, 1) + "\n");

  const bytes = JSON.stringify(artifact).length;
  const methods = operations.reduce<Record<string, number>>((acc, o) => {
    acc[o.method] = (acc[o.method] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `build-spec: ${operations.length} operations, ${artifact.controllers.length} controllers, ` +
      `${(bytes / 1024).toFixed(0)} KB -> spec/remnawave-operations.json`
  );
  console.log(
    `  methods: ${Object.entries(methods)
      .sort()
      .map(([m, n]) => `${m.toUpperCase()}=${n}`)
      .join(" ")}`
  );
}

/**
 * Paths that change or destroy a lot of state at once. They get `destructiveHint` and,
 * at runtime, an explicit `confirm: true` gate.
 */
function isDestructivePath(path: string): boolean {
  return (
    /\/bulk(\/|$)/.test(path) ||
    /\/bulk-actions(\/|$)/.test(path) ||
    /delete-all/.test(path) ||
    /truncate/.test(path) ||
    /restart-all/.test(path)
  );
}

build();
