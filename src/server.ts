import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initDatabase } from "./database";
import { startEmbeddingWarmup } from "./embeddings";
import { getPromptItToolDefinitions, handlePromptItToolCall } from "./refiner";

initDatabase();

export const promptItServer = new McpServer(
  { name: "prompt-refiner", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

promptItServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getPromptItToolDefinitions(),
}));

promptItServer.server.setRequestHandler(CallToolRequestSchema, async (request) =>
  handlePromptItToolCall(request.params.name, request.params.arguments)
);

let stdioStarted = false;

export async function startPromptItStdioServer(): Promise<void> {
  if (stdioStarted) return;
  const transport = new StdioServerTransport();
  await promptItServer.connect(transport);
  stdioStarted = true;
  startEmbeddingWarmup();
  process.stderr.write("MCP prompt-refiner server connected (stdio).\n");
}

await startPromptItStdioServer();
