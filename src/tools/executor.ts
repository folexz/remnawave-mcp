/**
 * The single place where an operation + arguments become an HTTP call.
 *
 * Both tool surfaces go through it — the individual typed tools and the
 * `remnawave_call` dispatcher — so path templating, query handling, the write gate and
 * the destructive-operation confirmation behave identically no matter how the operation
 * was reached.
 */
import type { RemnawaveClient } from "../client.js";
import { RemnawaveError } from "../client.js";
import type { Config } from "../config.js";
import type { OperationDef } from "../spec.js";

/**
 * Object arguments are not always objects by the time they reach us.
 *
 * Some MCP clients forward untyped tool arguments verbatim, without parsing the JSON they
 * contain, so `params: "{}"` arrives where `params: {}` was meant. Refusing those makes
 * every operation uncallable from such a client, so a string is parsed once here and the
 * result carries on as if it had arrived parsed. Anything that is not a string is returned
 * untouched — the original code path.
 *
 * Every Remnawave request body and every query bag is a JSON object, so a string that
 * parses to something else (array, number, null) is still an error — just a legible one.
 */
export function coerceObjectArg(value: unknown, label: string): any {
  if (typeof value !== "string") return value;

  const text = value.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RemnawaveError(
      `'${label}' arrived as a string that could not be parsed as JSON` +
        (text ? `: ${text.length > 120 ? `${text.slice(0, 120)}…` : text}` : " (it was empty)") +
        `. Pass '${label}' as an object, or as its exact JSON text — e.g. ${label}={}.`
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    const got = Array.isArray(parsed) ? "an array" : parsed === null ? "null" : `a ${typeof parsed}`;
    throw new RemnawaveError(
      `'${label}' arrived as a string that parses to ${got}, but '${label}' must be an ` +
        `object. Pass '${label}' as an object, e.g. ${label}={}.`
    );
  }

  return parsed;
}

export async function executeOperation(
  client: RemnawaveClient,
  config: Config,
  op: OperationDef,
  argsRaw: Record<string, any> | string | undefined
): Promise<unknown> {
  const args: Record<string, any> = coerceObjectArg(argsRaw, "arguments") ?? {};

  if (op.adminJwtOnly && !config.allowAdminJwtOps) {
    throw new RemnawaveError(
      `'${op.name}' (${op.method.toUpperCase()} ${op.path}) is served only to a logged-in ` +
        `admin session (JWT); the panel rejects API tokens on it, so the request is not sent. ` +
        `If the token you configured really is an admin JWT, set ` +
        `REMNAWAVE_ALLOW_ADMIN_JWT_OPS=1 to allow these ${op.controller} endpoints.`
    );
  }

  if (op.mutating && !config.canWrite) {
    throw new RemnawaveError(
      `'${op.name}' is a ${op.method.toUpperCase()} operation and this server is running ` +
        `read-only. Set REMNAWAVE_API_TOKEN_WRITE to enable mutations.`
    );
  }

  if (op.mutating && op.destructive && !config.skipConfirm && args.confirm !== true) {
    throw new RemnawaveError(
      `'${op.name}' (${op.method.toUpperCase()} ${op.path}) affects many objects at once or ` +
        `deletes data. Re-issue the call with confirm=true to proceed, or set ` +
        `REMNAWAVE_SKIP_CONFIRM=1 to disable this gate entirely.`
    );
  }

  let resolvedPath = op.path;
  for (const p of op.pathParams) {
    const value = args[p];
    if (value === undefined || value === null || value === "") {
      throw new RemnawaveError(`Missing required path parameter '${p}' for ${op.name}.`);
    }
    resolvedPath = resolvedPath.replace(`{${p}}`, encodeURIComponent(String(value)));
  }

  const query: Record<string, unknown> = {};
  for (const q of op.queryParams) {
    if (args[q] !== undefined) query[q] = args[q];
  }
  // Anything the spec did not declare but the caller supplied under `query` is passed through;
  // Remnawave's filter syntax (filters[0][id]=...) is not expressible as OpenAPI parameters.
  const extraQuery = coerceObjectArg(args.query, "query");
  if (extraQuery) Object.assign(query, extraQuery);

  const missingRequired = (op.inputSchema.required ?? []).filter(
    (key: string) => key !== "body" && args[key] === undefined
  );
  if (missingRequired.length) {
    throw new RemnawaveError(
      `Missing required argument(s) for ${op.name}: ${missingRequired.join(", ")}. ` +
        `Call remnawave_describe_operation with operation="${op.name}" for the full schema.`
    );
  }
  const body = op.hasBody ? coerceObjectArg(args.body, "body") : undefined;
  if (op.hasBody && op.bodyRequired && body === undefined) {
    throw new RemnawaveError(
      `${op.name} requires a 'body' object. Call remnawave_describe_operation with ` +
        `operation="${op.name}" for the full request-body schema.`
    );
  }

  return client.request(op.method, resolvedPath, {
    query,
    body,
    mode: op.mutating ? "write" : "read",
  });
}

/** MCP tool annotations derived from the HTTP method. */
export function annotationsFor(op: OperationDef): Record<string, any> {
  return {
    title: op.summary || `${op.method.toUpperCase()} ${op.path}`,
    readOnlyHint: !op.mutating,
    destructiveHint: op.destructive,
    idempotentHint: ["put", "delete", "patch"].includes(op.method),
    openWorldHint: true,
  };
}
