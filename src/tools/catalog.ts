/**
 * Discovery + dispatch: the three tools that make all 205 operations reachable without
 * putting 205 tool definitions (~60k tokens of JSON Schema) into the model's context.
 *
 *   remnawave_list_operations     — browse/search the catalogue, one compact line per op
 *   remnawave_describe_operation  — full JSON Schema + field notes for one operation
 *   remnawave_call                — execute any operation by name
 *
 * The typical loop is list -> describe -> call, and for anything in the profile's typed
 * controllers the model can skip straight to the dedicated tool.
 */
import type { RemnawaveClient } from "../client.js";
import type { Config } from "../config.js";
import { GENERAL_NOTES, notesFor } from "../notes.js";
import {
  buildIndex,
  formatOperationLine,
  resolveOperation,
  searchOperations,
  type Catalogue,
} from "../spec.js";
import { coerceObjectArg, executeOperation } from "./executor.js";
import type { McpTool, ToolHandler, ToolSet } from "./types.js";

const LIST_LIMIT_DEFAULT = 60;

export function buildCatalogTools(
  client: RemnawaveClient,
  config: Config,
  catalogue: Catalogue
): ToolSet {
  const tools: McpTool[] = [];
  const handlers = new Map<string, ToolHandler>();
  const index = buildIndex(catalogue);

  const controllerList = catalogue.controllers.map((c) => c.slug).join(", ");

  /* ---------------------------------------------------------------- list */

  tools.push({
    name: "remnawave_list_operations",
    description:
      `Browse the ${catalogue.operationCount} operations of ${catalogue.apiTitle} ` +
      `(v${catalogue.apiVersion}). Call with no arguments for a per-controller overview, ` +
      `then narrow with 'controller' and/or a free-text 'query'. Every result line shows the ` +
      `tool/operation name, its arguments, whether it is a read or a write, and its HTTP route. ` +
      `Feed a name into remnawave_describe_operation or remnawave_call.\n` +
      `Controllers: ${controllerList}`,
    inputSchema: {
      type: "object",
      properties: {
        controller: {
          type: "string",
          description: `Restrict to one controller. One of: ${controllerList}.`,
        },
        query: {
          type: "string",
          description:
            "Free-text filter matched against name, path, summary and controller. " +
            "All whitespace-separated terms must match, e.g. 'bulk squad'.",
        },
        method: {
          type: "string",
          enum: ["get", "post", "put", "patch", "delete"],
          description: "Restrict to one HTTP method.",
        },
        mutating: {
          type: "boolean",
          description: "true = only write operations, false = only reads.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 205,
          description: `Maximum lines to return (default ${LIST_LIMIT_DEFAULT}).`,
        },
      },
      additionalProperties: false,
    },
    annotations: {
      title: "Remnawave: list API operations",
      readOnlyHint: true,
      openWorldHint: false,
    },
  });

  handlers.set("remnawave_list_operations", async (args) => {
    const noFilter =
      !args?.controller && !args?.query && !args?.method && args?.mutating === undefined;
    if (noFilter) {
      return {
        api: `${catalogue.apiTitle} v${catalogue.apiVersion}`,
        operations: catalogue.operationCount,
        writeEnabled: config.canWrite,
        toolProfile: config.profile,
        typedToolControllers:
          config.controllers === null ? "all" : config.controllers.join(", ") || "(none)",
        controllers: catalogue.controllers.map((c) => `${c.slug} (${c.count})`),
        hint:
          "Call again with controller=<slug> or query=<terms> to list operations. " +
          "Then remnawave_describe_operation for a schema, remnawave_call to execute.",
        notes: GENERAL_NOTES,
      };
    }

    const matches = searchOperations(catalogue.operations, {
      query: args?.query,
      controller: args?.controller,
      method: args?.method,
      mutating: args?.mutating,
    });
    const limit = Math.max(1, Math.min(Number(args?.limit ?? LIST_LIMIT_DEFAULT), 205));
    return {
      matched: matches.length,
      shown: Math.min(matches.length, limit),
      operations: matches.slice(0, limit).map(formatOperationLine),
      ...(matches.length > limit
        ? { hint: `${matches.length - limit} more — narrow the query or raise 'limit'.` }
        : {}),
    };
  });

  /* ------------------------------------------------------------ describe */

  tools.push({
    name: "remnawave_describe_operation",
    description:
      "Return the complete input JSON Schema, HTTP route and field notes for one Remnawave " +
      "operation. Use it before remnawave_call whenever the request body is non-trivial — " +
      "large schemas are truncated in tools/list but always complete here.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description:
            "Operation name (e.g. 'remnawave_patch_config_profiles'), spec operationId " +
            "(e.g. 'ConfigProfileController_updateConfigProfile') or 'METHOD /path' " +
            "(e.g. 'patch /api/config-profiles').",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    annotations: {
      title: "Remnawave: describe API operation",
      readOnlyHint: true,
      openWorldHint: false,
    },
  });

  handlers.set("remnawave_describe_operation", async (args) => {
    const ref = String(args?.operation ?? "");
    const op = resolveOperation(index, ref);
    if (!op) {
      const suggestions = searchOperations(catalogue.operations, { query: ref })
        .slice(0, 10)
        .map((o) => o.name);
      throw new Error(
        `Unknown operation '${ref}'.` +
          (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "") +
          " Use remnawave_list_operations to browse."
      );
    }
    const notes = notesFor(op.method, op.path, op.controllerSlug);
    return {
      name: op.name,
      operationId: op.operationId,
      route: `${op.method.toUpperCase()} ${op.path}`,
      controller: op.controller,
      summary: op.summary,
      description: op.description,
      mutating: op.mutating,
      destructive: op.destructive,
      callable:
        (op.mutating ? config.canWrite : true) && (!op.adminJwtOnly || config.allowAdminJwtOps),
      ...(op.adminJwtOnly
        ? {
            adminJwtOnly:
              "the panel rejects API tokens on this endpoint; set " +
              "REMNAWAVE_ALLOW_ADMIN_JWT_OPS=1 only if your token is an admin JWT",
          }
        : {}),
      ...(op.mutating && !config.canWrite
        ? { blocked: "read-only server: set REMNAWAVE_API_TOKEN_WRITE to enable" }
        : {}),
      ...(op.destructive && op.mutating && !config.skipConfirm
        ? { requiresConfirm: "pass confirm=true inside params" }
        : {}),
      inputSchema: op.inputSchema,
      ...(notes.length ? { notes } : {}),
    };
  });

  /* ---------------------------------------------------------------- call */

  tools.push({
    name: "remnawave_call",
    description:
      `Execute any of the ${catalogue.operationCount} Remnawave API operations by name. ` +
      "This is the universal dispatcher: everything the panel exposes is reachable through " +
      "it, including operations that have no dedicated tool under the current profile. " +
      "Path and query parameters and the request body all go inside 'params', exactly as " +
      "described by remnawave_describe_operation. Write operations require a write token; " +
      "destructive ones additionally require params.confirm = true.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description:
            "Operation name, operationId, or 'METHOD /path'. See remnawave_list_operations.",
        },
        params: {
          type: "object",
          description:
            "Arguments: path parameters and query parameters as top-level keys, the request " +
            "body under 'body'. Undeclared query keys may be passed under 'query'. " +
            "A JSON string is accepted here too and parsed for you, for clients that cannot " +
            "send nested objects.",
          additionalProperties: true,
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    annotations: {
      title: "Remnawave: call API operation",
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true,
    },
  });

  handlers.set("remnawave_call", async (args) => {
    const ref = String(args?.operation ?? "");
    const op = resolveOperation(index, ref);
    if (!op) {
      const suggestions = searchOperations(catalogue.operations, { query: ref })
        .slice(0, 10)
        .map((o) => o.name);
      throw new Error(
        `Unknown operation '${ref}'.` +
          (suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "") +
          " Use remnawave_list_operations to browse."
      );
    }
    const params = (coerceObjectArg(args?.params, "params") ?? {}) as Record<string, any>;
    return executeOperation(client, config, op, params);
  });

  return { tools, handlers };
}
