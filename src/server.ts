import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getEmbedding } from "./memory/embeddings";
import { getContextualExamples } from "./memory/fewShot";
import { BASE_REFINER_PROMPT } from "./prompts/base";
import { initDB, saveFeedback, savePrompt } from "./memory/db";


initDB();

getEmbedding("warmup").catch((err) => {
  process.stderr.write(`Warmup alert: ${err.message}\n`);
});

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

    // The Feedback tool
    {
      name: "record_feedback",
      description: "Records the user's reaction to a refined prompt to improve future refinements.",
      inputSchema: {
        type: "object",
        properties: {
          prompt_id: { type: "integer", description: "The ID of the prompt being rated." },
          rating: { type: "integer", description: "1 for good, -1 for bad, 0 for neutral." },
          user_edits: { type: "string", description: "The final version the user actually used (if they edited it)." },
        },
        required: ["prompt_id", "rating"],
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
    const promptId = savePrompt(rawPrompt, finalpromt, currentVector);


    return {
      content: [{ type: "text", text: `[PROMPT_ID: ${promptId}]\n Prompted version of: ${finalpromt}` }],
    };
  }
  if (request.params.name === "record_feedback") {
    const args = request.params.arguments;
    const promptId = args?.prompt_id;
    const rating = args?.rating;
    const userEdits = args?.user_edits;

    const promptIdNum = typeof promptId === "number" && Number.isInteger(promptId) ? promptId : null;
    const ratingNum = typeof rating === "number" && Number.isInteger(rating) ? rating : null;

    if (promptIdNum === null || ratingNum === null) {
      throw new Error("record_feedback requires integer prompt_id and rating.");
    }

    if (ratingNum < -1 || ratingNum > 1) {
      throw new Error("record_feedback rating must be -1, 0, or 1.");
    }

    if (userEdits !== undefined && typeof userEdits !== "string") {
      throw new Error("record_feedback user_edits must be a string when provided.");
    }

    const feedbackId = saveFeedback(promptIdNum, ratingNum, userEdits);
    return {
      content: [{ type: "text", text: `Feedback recorded (id: ${feedbackId}) for prompt ${promptIdNum}.` }],
    };
  }

  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write("Testing MCP")
