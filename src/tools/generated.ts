/**
 * One MCP tool per spec operation, for the controllers selected by the tool profile.
 *
 * Two filters run here:
 *   - profile/controller selection (config.controllers) decides which operations get a
 *     dedicated tool at all — see README "Why not 205 tools";
 *   - the write gate: with no write token configured, mutating operations are not added to
 *     the set, so they are invisible in tools/list and cannot be called.
 *
 * Oversized schemas are collapsed for the listing; the full schema remains available via
 * remnawave_describe_operation.
 */
import type { RemnawaveClient } from "../client.js";
import type { Config } from "../config.js";
import { collapseSchema, type OperationDef } from "../spec.js";
import { notesFor } from "../notes.js";
import { annotationsFor, executeOperation } from "./executor.js";
import type { McpTool, ToolHandler, ToolSet } from "./types.js";

export function buildGeneratedTools(
  client: RemnawaveClient,
  config: Config,
  operations: OperationDef[]
): ToolSet {
  const tools: McpTool[] = [];
  const handlers = new Map<string, ToolHandler>();

  const selected = operations.filter((op) => {
    if (config.controllers !== null && !config.controllers.includes(op.controllerSlug)) return false;
    if (op.mutating && !config.canWrite) return false;
    return true;
  });

  for (const op of selected) {
    const notes = notesFor(op.method, op.path, op.controllerSlug);
    const schema = collapseSchema(op.inputSchema, config.maxSchemaBytes, op.name);

    // Destructive operations carry an explicit confirmation flag.
    const inputSchema =
      op.destructive && op.mutating && !config.skipConfirm
        ? {
            ...schema,
            properties: {
              ...schema.properties,
              confirm: {
                type: "boolean",
                description:
                  "Must be true. This operation changes or deletes many objects at once.",
              },
            },
            required: [...new Set([...(schema.required ?? []), "confirm"])],
          }
        : schema;

    tools.push({
      name: op.name,
      description: [
        op.description,
        `[${op.method.toUpperCase()} ${op.path}]`,
        ...notes.map((n) => `NOTE: ${n}`),
      ].join("\n"),
      inputSchema,
      annotations: annotationsFor(op),
    });

    handlers.set(op.name, (args) => executeOperation(client, config, op, args));
  }

  return { tools, handlers };
}
