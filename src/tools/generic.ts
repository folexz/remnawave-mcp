/**
 * Escape hatches — reach any HTTP path on the panel, including routes that a given panel
 * build exposes but this spec does not describe (plugin endpoints, newer minor versions,
 * or the `filters[0][id]=` query style that OpenAPI cannot express).
 *
 *   remnawave_request_read  — GET only, read token.
 *   remnawave_request_write — POST/PATCH/PUT/DELETE, write token, only when writes are on.
 */
import type { RemnawaveClient } from "../client.js";
import { coerceObjectArg } from "./executor.js";
import type { Config } from "../config.js";
import type { McpTool, ToolHandler, ToolSet } from "./types.js";

export function buildGenericTools(client: RemnawaveClient, config: Config): ToolSet {
  const tools: McpTool[] = [];
  const handlers = new Map<string, ToolHandler>();

  tools.push({
    name: "remnawave_request_read",
    description:
      "Low-level GET against any Remnawave path using the READ token. Use when no typed tool " +
      "or catalogue operation fits — e.g. undocumented routes, or query syntax the spec " +
      "cannot express such as filters[0][id]=username&filters[0][value]=foo. " +
      "'path' must start with '/', e.g. '/api/system/stats'. The {\"response\": ...} envelope " +
      "is unwrapped for you.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "API path starting with '/', e.g. '/api/users' or '/api/nodes/{uuid}'.",
        },
        query: {
          type: "object",
          description: "Query parameters (key -> value; arrays become repeated keys).",
          additionalProperties: true,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { title: "Remnawave: raw GET", readOnlyHint: true, openWorldHint: true },
  });

  handlers.set("remnawave_request_read", async (args) => {
    const path = String(args?.path ?? "");
    if (!path.startsWith("/")) throw new Error("path must start with '/'");
    const query = coerceObjectArg(args?.query, "query");
    return client.request("GET", path, { query, mode: "read" });
  });

  if (config.canWrite) {
    tools.push({
      name: "remnawave_request_write",
      description:
        "Low-level mutating request (POST/PATCH/PUT/DELETE) against any Remnawave path using " +
        "the WRITE token. Changes live panel state — use deliberately. Mutations are " +
        "throttled and retried by this server because each config write restarts Xray on the " +
        "nodes. Remember that PATCH /api/config-profiles replaces the whole config: send " +
        "{uuid, config} with a COMPLETE config, or the panel answers A061.",
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["POST", "PATCH", "PUT", "DELETE"],
            description: "HTTP method.",
          },
          path: { type: "string", description: "API path starting with '/'." },
          body: { type: "object", description: "Request body (JSON).", additionalProperties: true },
          query: {
            type: "object",
            description: "Query parameters (key -> value).",
            additionalProperties: true,
          },
        },
        required: ["method", "path"],
        additionalProperties: false,
      },
      annotations: { title: "Remnawave: raw write", destructiveHint: true, openWorldHint: true },
    });

    handlers.set("remnawave_request_write", async (args) => {
      const method = String(args?.method ?? "").toUpperCase();
      const path = String(args?.path ?? "");
      if (!["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
        throw new Error("method must be POST, PATCH, PUT or DELETE");
      }
      if (!path.startsWith("/")) throw new Error("path must start with '/'");
      const body = coerceObjectArg(args?.body, "body");
      const query = coerceObjectArg(args?.query, "query");
      return client.request(method, path, { body, query, mode: "write" });
    });
  }

  return { tools, handlers };
}
