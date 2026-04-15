import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getEmbedding, startEmbeddingWarmup } from "./memory/embeddings";
import { getContextualExamples } from "./memory/fewShot";
import { BASE_REFINER_PROMPT } from "./prompts/base";
import { initDB, savePrompt } from "./memory/db";
import { recordFeedback } from "./tools/recordFeedback";  

initDB();

const server = new McpServer(
  { name: "prompt-engineer", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

type FeedbackArgs = {
  promptId: number;
  rating: -1 | 0 | 1;
  userEdits?: string;
};

function parseFeedbackArgs(input: unknown): FeedbackArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const promptIdRaw = args.prompt_id;
  const ratingRaw = args.rating;
  const userEditsRaw = args.user_edits;

  if (typeof promptIdRaw !== "number" || !Number.isInteger(promptIdRaw) || promptIdRaw <= 0) {
    throw new Error("prompt_id must be a positive integer.");
  }

  if (typeof ratingRaw !== "number" || !Number.isInteger(ratingRaw) || ![-1, 0, 1].includes(ratingRaw)) {
    throw new Error("rating must be one of: -1, 0, 1.");
  }

  if (userEditsRaw !== undefined && typeof userEditsRaw !== "string") {
    throw new Error("user_edits must be a string when provided.");
  }

  return {
    promptId: promptIdRaw,
    rating: ratingRaw as -1 | 0 | 1,
    userEdits: userEditsRaw,
  };
}

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
      .replace("{examples}", examples || "No history found yet.")
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
    try {
      const { promptId, rating, userEdits } = parseFeedbackArgs(request.params.arguments);
      recordFeedback(promptId, rating, userEdits);
      return {
        content: [{ type: "text", text: "Feedback recorded. Your personal model is learning!" }]
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: `Error saving feedback: ${error.message}` }],
        isError: true
      };
    }
  }

  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
await server.connect(transport);
startEmbeddingWarmup();

process.stderr.write("Testing MCP")
