import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getEmbedding } from "./memory/embeddings";
import { getContextualExamples } from "./memory/fewShot";
import { BASE_REFINER_PROMPT } from "./prompts/base";
import { savePrompt } from "./memory/db";



getEmbedding("warmup").catch(()=>{});

const server = new McpServer(
  { name: "prompt-engineer", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// This tells the AI what tools are available
server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "prompt_it",
      description: "Refines a messy user prompt into a structured, high-quality system prompt/instruction.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The raw user input prompt" },
        },
        required: ["prompt"],
      },
    },
  ],
}));

// This is where the logic will eventually go
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "prompt_it") {
    const rawPrompt = request.params.arguments?.prompt as string;

    const examples = await getContextualExamples(rawPrompt)
    
    const finalpromt = BASE_REFINER_PROMPT
      .replace("{example}", examples || "No history found yet.")
      .replace("{input}", rawPrompt);

  // 3. THE MISSING PIECE: Pre-calculate the embedding and save
  // This ensures your history grows every time you use the tool. 
    const currentVector = await getEmbedding(rawPrompt);
    savePrompt(rawPrompt, finalpromt, currentVector);


    return {
      content: [{ type: "text", text: `Prompted version of: ${finalpromt}` }],
    };
  }
  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
await server.connect(transport);