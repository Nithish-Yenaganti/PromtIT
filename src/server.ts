import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getEmbedding, startEmbeddingWarmup } from "./memory/embeddings";
import { getContextualExamples } from "./memory/fewShot";
import { getRecentRefinements, initDB, savePrompt } from "./memory/db";
import { recordFeedback } from "./tools/recordFeedback";

initDB();

const server = new McpServer(
  { name: "prompt-refiner", version: "2.0.0" },
  { capabilities: { tools: {} } }
);

type StoreArgs = {
  rawText: string;
  refinedText: string;
};

type RecallArgs = {
  query: string;
};

type PromptItArgs = {
  messyText: string;
};

type FeedbackArgs = {
  promptId: number;
  rating: -1 | 0 | 1;
  userEdits?: string;
};

const MAX_TEXT_CHARS = 16000;
const MAX_USER_EDITS_CHARS = 16000;

function parseStoreArgs(input: unknown): StoreArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const rawText = args.raw_text;
  const refinedText = args.refined_text;

  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("raw_text must be a non-empty string.");
  }
  if (typeof refinedText !== "string" || !refinedText.trim()) {
    throw new Error("refined_text must be a non-empty string.");
  }
  if (rawText.length > MAX_TEXT_CHARS || refinedText.length > MAX_TEXT_CHARS) {
    throw new Error(`raw_text/refined_text cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }

  return { rawText, refinedText };
}

function parseRecallArgs(input: unknown): RecallArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const query = args.query;
  if (typeof query !== "string" || !query.trim()) {
    throw new Error("query must be a non-empty string.");
  }
  if (query.length > MAX_TEXT_CHARS) {
    throw new Error(`query cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }
  return { query };
}

function parsePromptItArgs(input: unknown): PromptItArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const messyTextRaw = args.messy_text ?? args.prompt;

  if (typeof messyTextRaw !== "string" || !messyTextRaw.trim()) {
    throw new Error("messy_text must be a non-empty string.");
  }
  if (messyTextRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`messy_text cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }

  return { messyText: messyTextRaw };
}

function parseFeedbackArgs(input: unknown): FeedbackArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const promptIdRaw = args.prompt_id;
  const ratingRaw = args.rating;
  const userEditsRaw = args.user_edits;

  if (
    typeof promptIdRaw !== "number" ||
    !Number.isInteger(promptIdRaw) ||
    promptIdRaw <= 0
  ) {
    throw new Error("prompt_id must be a positive integer.");
  }
  if (
    typeof ratingRaw !== "number" ||
    !Number.isInteger(ratingRaw) ||
    ![-1, 0, 1].includes(ratingRaw)
  ) {
    throw new Error("rating must be one of: -1, 0, 1.");
  }
  if (userEditsRaw !== undefined && typeof userEditsRaw !== "string") {
    throw new Error("user_edits must be a string when provided.");
  }
  if (
    typeof userEditsRaw === "string" &&
    userEditsRaw.length > MAX_USER_EDITS_CHARS
  ) {
    throw new Error(`user_edits exceeds ${MAX_USER_EDITS_CHARS} characters.`);
  }

  return {
    promptId: promptIdRaw,
    rating: ratingRaw as -1 | 0 | 1,
    userEdits: userEditsRaw,
  };
}

server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "prompt_it",
      description:
        "Primary entrypoint: takes messy text, recalls similar refinements, and returns a host-ready conversion payload.",
      inputSchema: {
        type: "object",
        properties: {
          messy_text: {
            type: "string",
            description: "The messy user input to prepare for host-side conversion.",
          },
          prompt: {
            type: "string",
            description: "Deprecated alias for messy_text.",
          },
        },
      },
    },
    {
      name: "store_refinement",
      description:
        "Stores a pre-refined prompt pair and embedding in local SQLite memory.",
      inputSchema: {
        type: "object",
        properties: {
          raw_text: { type: "string", description: "The original messy user text." },
          refined_text: {
            type: "string",
            description:
              "The structured prompt produced by the host agent and ready for execution.",
          },
        },
        required: ["raw_text", "refined_text"],
      },
    },
    {
      name: "recall_refinements",
      description:
        "Returns similar previously accepted refinements for a query to support prompt engineering context.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The query to search similar history for." },
        },
        required: ["query"],
      },
    },
    {
      name: "recall_refinments",
      description:
        "Deprecated alias for recall_refinements (kept for backward compatibility with older host configs).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The query to search similar history for." },
        },
        required: ["query"],
      },
    },
    {
      name: "record_feedback",
      description:
        "Records quality feedback for a stored refinement to improve memory relevance.",
      inputSchema: {
        type: "object",
        properties: {
          prompt_id: { type: "integer", description: "The prompt_history row ID." },
          rating: { type: "integer", description: "1 good, -1 bad, 0 neutral." },
          user_edits: {
            type: "string",
            description: "Optional final prompt text after user edits.",
          },
        },
        required: ["prompt_id", "rating"],
      },
    },
  ],
}));

server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "prompt_it") {
    const { messyText } = parsePromptItArgs(request.params.arguments);

    let examplesText = "";
    let recallNotice = "";
    try {
      const queryEmbedding = await getEmbedding(messyText);
      examplesText = await getContextualExamples(messyText, queryEmbedding);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`prompt_it recall path failed: ${message}\n`);
      const recent = getRecentRefinements(3);
      examplesText =
        recent.length > 0
          ? recent
              .map((x) => `User: ${x.raw_prompt}\nRefined: ${x.refined_prompt}`)
              .join("\n\n")
          : "No relevant refinement history found yet.";
      recallNotice =
        "Notice: embedding recall is unavailable, so recent refinements were used instead.\n\n";
    }

    const examplesBlock = examplesText || "No relevant refinement history found yet.";
    const conversionInput = [
      "MESSY_TEXT:",
      messyText,
      "",
      "SIMILAR_REFINEMENTS:",
      examplesBlock,
      "",
      "HOST_TASK:",
      "Rewrite MESSY_TEXT into a clean, structured system prompt. Return only the refined prompt text.",
    ].join("\n");

    return {
      content: [
        {
          type: "text",
          text: `${recallNotice}${conversionInput}`,
        },
      ],
    };
  }

  if (request.params.name === "store_refinement") {
    const { rawText, refinedText } = parseStoreArgs(request.params.arguments);
    let embedding: number[] | null = null;
    let notice = "";
    try {
      embedding = await getEmbedding(rawText);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Embedding failed during store_refinement: ${message}\n`);
      notice =
        "\nNote: Saved without embedding due to runtime issue. Semantic recall may be limited until embeddings recover.";
    }

    const promptId = savePrompt(rawText, refinedText, embedding);

    return {
      content: [
        {
          type: "text",
          text: `Stored refinement successfully.\nPROMPT_ID: ${promptId}${notice}`,
        },
      ],
    };
  }

  if (
    request.params.name === "recall_refinements" ||
    request.params.name === "recall_refinments"
  ) {
    const { query } = parseRecallArgs(request.params.arguments);
    try {
      const queryEmbedding = await getEmbedding(query);
      const examples = await getContextualExamples(query, queryEmbedding);

      return {
        content: [
          {
            type: "text",
            text: examples || "No relevant refinement history found yet.",
          },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Embedding failed during recall_refinements: ${message}\n`);
      const recent = getRecentRefinements(3);
      const fallback =
        recent.length > 0
          ? [
              "Embedding runtime is currently unavailable; showing recent refinements instead.",
              "",
              ...recent.map((x) => `User: ${x.raw_prompt}\nRefined: ${x.refined_prompt}`),
            ].join("\n\n")
          : "Embedding runtime is currently unavailable and no refinement history exists yet.";

      return {
        content: [{ type: "text", text: fallback }],
      };
    }
  }

  if (request.params.name === "record_feedback") {
    try {
      const { promptId, rating, userEdits } = parseFeedbackArgs(request.params.arguments);
      recordFeedback(promptId, rating, userEdits);
      return {
        content: [
          { type: "text", text: "Feedback recorded. Prompt memory is updated." },
        ],
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`record_feedback failed: ${message}\n`);
      return {
        content: [{ type: "text", text: "Unable to record feedback right now." }],
        isError: true,
      };
    }
  }

  throw new Error("Tool not found");
});

const transport = new StdioServerTransport();
await server.connect(transport);
startEmbeddingWarmup();

process.stderr.write("MCP prompt-refiner server connected.\n");
