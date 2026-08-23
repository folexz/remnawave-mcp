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

export async function executeOperation(
  client: RemnawaveClient,
  config: Config,
  op: OperationDef,
  argsRaw: Record<string, any> | undefined
): Promise<unknown> {
  const args = argsRaw ?? {};

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
  if (args.query && typeof args.query === "object") Object.assign(query, args.query);

  const missingRequired = (op.inputSchema.required ?? []).filter(
    (key: string) => key !== "body" && args[key] === undefined
  );
  if (missingRequired.length) {
    throw new RemnawaveError(
      `Missing required argument(s) for ${op.name}: ${missingRequired.join(", ")}. ` +
        `Call remnawave_describe_operation with operation="${op.name}" for the full schema.`
    );
  }
  if (op.hasBody && op.bodyRequired && args.body === undefined) {
    throw new RemnawaveError(
      `${op.name} requires a 'body' object. Call remnawave_describe_operation with ` +
        `operation="${op.name}" for the full request-body schema.`
    );
  }

  return client.request(op.method, resolvedPath, {
    query,
    body: op.hasBody ? args.body : undefined,
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
