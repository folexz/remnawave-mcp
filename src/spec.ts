/**
 * Loads the pre-built operation catalogue (spec/remnawave-operations.json) and provides
 * lookup, search and schema-collapsing helpers on top of it.
 *
 * The catalogue is produced offline by `npm run build-spec` from the raw OpenAPI document,
 * so nothing has to be dereferenced at start-up: the server reads one JSON file and is ready.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The catalogue sits one level up from both `src/` and `dist/`.
const CATALOGUE_PATH = join(__dirname, "..", "spec", "remnawave-operations.json");

export type Json = Record<string, any>;

export interface OperationDef {
  name: string;
  operationId: string;
  method: string; // lowercase
  path: string; // template with {param}
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

export interface Catalogue {
  apiTitle: string;
  apiVersion: string;
  openapi: string;
  operationCount: number;
  controllers: { name: string; slug: string; count: number }[];
  operations: OperationDef[];
}

let cached: Catalogue | null = null;

export function loadCatalogue(): Catalogue {
  if (!cached) cached = JSON.parse(readFileSync(CATALOGUE_PATH, "utf8")) as Catalogue;
  return cached;
}

/** Index by tool name, operationId and `METHOD /path`, so callers can use whichever they have. */
export function buildIndex(catalogue: Catalogue): Map<string, OperationDef> {
  const index = new Map<string, OperationDef>();
  for (const op of catalogue.operations) {
    index.set(op.name.toLowerCase(), op);
    index.set(op.operationId.toLowerCase(), op);
    index.set(`${op.method} ${op.path}`.toLowerCase(), op);
  }
  return index;
}

export function resolveOperation(
  index: Map<string, OperationDef>,
  ref: string
): OperationDef | undefined {
  const key = ref.trim().toLowerCase();
  return (
    index.get(key) ??
    index.get(key.replace(/\s+/, " ")) ??
    index.get(`remnawave_${key}`) // allow the prefix to be omitted
  );
}

/**
 * Shrinks an oversized input schema for `tools/list`.
 *
 * A handful of Remnawave DTOs are enormous once dereferenced — a single host object is
 * ~29 KB of JSON Schema because it embeds every inbound/security variant. Advertising those
 * verbatim would cost more context than the rest of the server put together, so anything
 * above the budget keeps its top-level property names, types and one-line descriptions and
 * drops the nesting. The complete schema stays one `remnawave_describe_operation` call away.
 */
export function collapseSchema(schema: Json, maxBytes: number, opName: string): Json {
  if (JSON.stringify(schema).length <= maxBytes) return schema;

  const props: Json = {};
  for (const [key, valueRaw] of Object.entries(schema.properties ?? {})) {
    const value = valueRaw as Json;
    const serialized = JSON.stringify(value);
    if (serialized.length <= 400) {
      props[key] = value;
      continue;
    }
    props[key] = {
      ...(value.type ? { type: value.type } : { type: "object" }),
      ...(value.type === "object" || value.properties
        ? { additionalProperties: true }
        : {}),
      ...(value.type === "array" ? { items: { type: "object", additionalProperties: true } } : {}),
      description: summarizeSchema(value, key, opName),
    };
  }

  return {
    type: "object",
    properties: props,
    ...(schema.required ? { required: schema.required } : {}),
    // Deep validation is skipped locally; the panel validates and returns a precise error.
    additionalProperties: false,
  };
}

function summarizeSchema(value: Json, key: string, opName: string): string {
  const head = value.description ? `${value.description.split("\n")[0]} ` : "";
  const inner = value.type === "array" ? value.items ?? {} : value;
  const fields = Object.keys(inner.properties ?? {});
  const fieldHint = fields.length
    ? `Fields: ${fields.slice(0, 40).join(", ")}${fields.length > 40 ? ", ..." : ""}. `
    : "";
  const requiredHint = Array.isArray(inner.required) && inner.required.length
    ? `Required: ${inner.required.join(", ")}. `
    : "";
  return (
    `${head}${fieldHint}${requiredHint}` +
    `Schema truncated — call remnawave_describe_operation with operation="${opName}" ` +
    `for the full JSON Schema of '${key}'.`
  );
}

/** Free-text search over name, path, summary and controller. */
export function searchOperations(
  operations: OperationDef[],
  opts: { query?: string; controller?: string; method?: string; mutating?: boolean }
): OperationDef[] {
  const terms = (opts.query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  return operations.filter((op) => {
    if (opts.controller && op.controllerSlug !== opts.controller.toLowerCase()) return false;
    if (opts.method && op.method !== opts.method.toLowerCase()) return false;
    if (opts.mutating !== undefined && op.mutating !== opts.mutating) return false;
    if (!terms.length) return true;
    const haystack =
      `${op.name} ${op.operationId} ${op.method} ${op.path} ${op.summary} ${op.controller}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  });
}

/** One compact line per operation, used by remnawave_list_operations. */
export function formatOperationLine(op: OperationDef): string {
  const args = [
    ...op.pathParams,
    ...op.queryParams.map((q) => `${q}?`),
    ...(op.hasBody ? [op.bodyRequired ? "body" : "body?"] : []),
  ];
  const argHint = args.length ? ` (${args.join(", ")})` : "";
  const flags = [op.mutating ? "WRITE" : "read", op.destructive ? "DESTRUCTIVE" : null]
    .filter(Boolean)
    .join("/");
  return `${op.name}${argHint} [${flags}] — ${op.method.toUpperCase()} ${op.path}${
    op.summary ? ` — ${op.summary}` : ""
  }`;
}
