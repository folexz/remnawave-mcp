#!/usr/bin/env node
/**
 * remnawave-mcp — an MCP server for the Remnawave panel API (v3.3.2).
 *
 * Tool surface, from the outside in:
 *
 *   1. Catalogue tools (always on): remnawave_list_operations / _describe_operation / _call.
 *      They make all 205 spec operations reachable at a fixed, tiny context cost.
 *   2. Typed tools (profile-controlled): one generated tool per operation for the selected
 *      controllers — 'core' by default, 'full' for everything, 'minimal' for none.
 *   3. Escape hatches: remnawave_request_read / remnawave_request_write for anything the
 *      spec does not cover.
 *
 * Read and write are separated by two tokens. Without a write token, mutating tools are not
 * registered and the dispatcher refuses mutations.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { RemnawaveClient } from "./client.js";
import { loadConfig } from "./config.js";
import { loadCatalogue } from "./spec.js";
import { buildCatalogTools } from "./tools/catalog.js";
import { buildGeneratedTools } from "./tools/generated.js";
import { buildGenericTools } from "./tools/generic.js";
import type { McpTool, ToolHandler } from "./tools/types.js";

export const SERVER_VERSION = "0.1.0";

export function buildServer(env: NodeJS.ProcessEnv = process.env) {
  const config = loadConfig(env);
  const catalogue = loadCatalogue();
  const client = new RemnawaveClient(config);

  const catalog = buildCatalogTools(client, config, catalogue);
  const generated = buildGeneratedTools(client, config, catalogue.operations);
  const generic = buildGenericTools(client, config);

  const tools: McpTool[] = [...catalog.tools, ...generated.tools, ...generic.tools];
  const handlers = new Map<string, ToolHandler>([
    ...catalog.handlers,
    ...generated.handlers,
    ...generic.handlers,
  ]);

  const server = new Server(
    { name: "remnawave-mcp", version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const handler = handlers.get(req.params.name);
    if (!handler) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      };
    }
    try {
      const result = await handler((req.params.arguments ?? {}) as Record<string, any>);
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      };
    }
  });

  return { server, config, catalogue, tools, handlers, generatedCount: generated.tools.length };
}

async function main() {
  const { server, config, catalogue, tools, generatedCount } = buildServer();
  await server.connect(new StdioServerTransport());

  // stderr only — stdout carries the MCP JSON-RPC stream.
  console.error(
    `remnawave-mcp ${SERVER_VERSION} ready against ${config.baseUrl} ` +
      `(${catalogue.apiTitle}, ${catalogue.operationCount} operations)\n` +
      `  tools: ${tools.length} exposed — profile '${config.profile}' ` +
      `(${generatedCount} typed + catalogue dispatcher + escape hatches)\n` +
      `  write: ${config.canWrite ? "ENABLED" : "off (read-only)"}`
  );
}

// Only run when executed directly, so tests can import buildServer().
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fatal:", (err as Error).message);
    process.exit(1);
  });
}
