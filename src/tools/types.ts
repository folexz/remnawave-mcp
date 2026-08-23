/** Shared types for tool sets. */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
  annotations?: Record<string, any>;
}

export type ToolHandler = (args: Record<string, any>) => Promise<unknown>;

export interface ToolSet {
  tools: McpTool[];
  handlers: Map<string, ToolHandler>;
}
