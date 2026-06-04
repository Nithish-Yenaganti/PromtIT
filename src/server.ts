import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initDatabase } from "./database";
import { bootstrapPromptsChatTemplates } from "./promptsChatSync";
import { getPromptItToolDefinitions, handlePromptItToolCall } from "./refiner";

initDatabase();

export const promptItServer = new McpServer(
  { name: "promptit-mcp", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

promptItServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getPromptItToolDefinitions(),
}));

promptItServer.server.setRequestHandler(CallToolRequestSchema, async (request) =>
  handlePromptItToolCall(request.params.name, request.params.arguments)
);

let stdioStarted = false;
let bootstrapStarted = false;

export async function startPromptItStdioServer(): Promise<void> {
  if (stdioStarted) return;
  const transport = new StdioServerTransport();
  await promptItServer.connect(transport);
  stdioStarted = true;
  process.stderr.write("PromptIT MCP server connected (stdio).\n");
  startBootstrapSync();
}

function startBootstrapSync(): void {
  if (bootstrapStarted || process.env.PROMPTIT_DISABLE_BOOTSTRAP_SYNC === "1") return;
  bootstrapStarted = true;
  bootstrapPromptsChatTemplates({ templatesPerCategory: 1 }).then(
    (result) => {
      process.stderr.write(
        `PromptIT prompts.chat bootstrap sync finished: imported=${result.totals.imported_count}, failed=${result.totals.failed_count}\n`
      );
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`PromptIT prompts.chat bootstrap sync skipped: ${message}\n`);
    }
  );
}

await startPromptItStdioServer();
