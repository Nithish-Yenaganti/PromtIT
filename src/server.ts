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

const MAX_PROMPT_CHARS = 16000;
const MAX_USER_EDITS_CHARS = 16000;

function extractSampledText(content: unknown): string {
  if (Array.isArray(content)) {
    const firstText = content.find(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as { type?: string }).type === "text" &&
        "text" in block
    ) as { text?: unknown } | undefined;
    if (typeof firstText?.text === "string" && firstText.text.trim()) {
      return firstText.text.trim();
    }
    throw new Error("Sampling returned no text content.");
  }

  if (
    typeof content === "object" &&
    content !== null &&
    "type" in content &&
    (content as { type?: string }).type === "text" &&
    "text" in content
  ) {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string" && text.trim()) return text.trim();
  }

  throw new Error("Sampling returned an unsupported content format.");
}

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
  if (typeof userEditsRaw === "string" && userEditsRaw.length > MAX_USER_EDITS_CHARS) {
    throw new Error(`user_edits exceeds ${MAX_USER_EDITS_CHARS} characters.`);
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

// This is where the logic will eventually 
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "prompt_it") {
    const rawPrompt = request.params.arguments?.prompt;
    if (typeof rawPrompt !== "string" || !rawPrompt.trim()) {
      throw new Error("prompt must be a non-empty string.");
    }
    if (rawPrompt.length > MAX_PROMPT_CHARS) {
      throw new Error(`prompt exceeds ${MAX_PROMPT_CHARS} characters.`);
    }
    const currentVector = await getEmbedding(rawPrompt);

    const examples = await getContextualExamples(rawPrompt, currentVector);

    const refinementRequest = BASE_REFINER_PROMPT
      .replace("{examples}", examples || "No history found yet.")
      .replace("{input}", rawPrompt);

    let refinedPrompt: string;
    try {
      const sampled = await server.server.createMessage({
        systemPrompt:
          "Act as an expert prompt engineer. Convert messy requests into a clear, execution-ready prompt. Return only the refined prompt text.",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: refinementRequest,
            },
          },
        ],
        includeContext: "thisServer",
        temperature: 0.2,
        maxTokens: 900,
      });
      refinedPrompt = extractSampledText(sampled.content);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const lower = message.toLowerCase();
      const isSamplingCapabilityError =
        lower.includes("does not support sampling") ||
        lower.includes("sampling/createmessage") ||
        lower.includes("method not found") ||
        lower.includes("-32601");
      return {
        content: [
          {
            type: "text",
            text: isSamplingCapabilityError
              ? "Unable to refine: connected MCP host does not support sampling/createMessage."
              : `Unable to refine prompt via sampling: ${message}`,
          },
        ],
        isError: true,
      };
    }

    // Save prompt + embedding so memory can improve future refinements.
    const promptId = savePrompt(rawPrompt, refinedPrompt, currentVector);


    return {
      content: [{ type: "text", text: `[PROMPT_ID: ${promptId}]\n${refinedPrompt}` }],
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
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`record_feedback failed: ${message}\n`);
      return {
        content: [{ type: "text", text: "Unable to record feedback right now." }],
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
