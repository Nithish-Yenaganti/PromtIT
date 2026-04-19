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
  { name: "prompt-refiner", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

type StoreArgs = {
  rawText: string;
  refinedText: string;
};

type PromptItArgs = {
  messyText: string;
};

type FeedbackArgs = {
  promptId: number;
  score: number;
  source: "LSP" | "Agent" | "User";
  metadata?: unknown;
};

const MAX_TEXT_CHARS = 16000;
const DEFAULT_CHARS_PER_TOKEN = 4;

function parsePositiveNumberEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function estimateTokens(text: string): number {
  const normalizedLength = text.trim().length;
  if (normalizedLength <= 0) return 0;
  return Math.ceil(normalizedLength / DEFAULT_CHARS_PER_TOKEN);
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(6)}`;
}

function buildTokenDiffReport(rawText: string, refinedText: string): string {
  const rawTokens = estimateTokens(rawText);
  const refinedTokens = estimateTokens(refinedText);
  const savedTokens = rawTokens - refinedTokens;
  const reductionPercent = rawTokens > 0 ? (savedTokens / rawTokens) * 100 : 0;

  const reportLines = [
    "Token Usage (Estimated):",
    `- Raw messy text: ${rawTokens} tokens`,
    `- Refined prompt: ${refinedTokens} tokens`,
    `- Difference: ${savedTokens >= 0 ? "-" : "+"}${Math.abs(savedTokens)} tokens`,
    `- Reduction: ${reductionPercent.toFixed(2)}%`,
  ];

  const inputCostPer1k = parsePositiveNumberEnv("PROMPTIT_INPUT_COST_PER_1K");
  if (inputCostPer1k !== null) {
    const rawCost = (rawTokens / 1000) * inputCostPer1k;
    const refinedCost = (refinedTokens / 1000) * inputCostPer1k;
    const savedCost = rawCost - refinedCost;
    reportLines.push(
      "",
      `Cost Impact (using PROMPTIT_INPUT_COST_PER_1K=${inputCostPer1k}):`,
      `- Raw estimated input cost: ${formatUsd(rawCost)}`,
      `- Refined estimated input cost: ${formatUsd(refinedCost)}`,
      `- Estimated savings: ${savedCost >= 0 ? "-" : "+"}${formatUsd(Math.abs(savedCost))}`
    );
  } else {
    reportLines.push(
      "",
      "Cost Impact:",
      "- Set PROMPTIT_INPUT_COST_PER_1K to include dollar estimates automatically."
    );
  }

  return reportLines.join("\n");
}

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

function parsePromptItArgs(input: unknown): PromptItArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const messyTextRaw = args.messy_text;

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
  const scoreRaw = args.score;
  const sourceRaw = args.source;
  const metadataRaw = args.metadata;

  if (typeof promptIdRaw !== "string" || !promptIdRaw.trim()) {
    throw new Error("prompt_id must be a non-empty string.");
  }
  const parsedPromptId = Number(promptIdRaw);
  if (!Number.isInteger(parsedPromptId) || parsedPromptId <= 0) {
    throw new Error("prompt_id must be a string containing a positive integer.");
  }

  if (typeof scoreRaw !== "number" || !Number.isFinite(scoreRaw)) {
    throw new Error("score must be a number between 0 and 1.");
  }
  if (scoreRaw < 0 || scoreRaw > 1) {
    throw new Error("score must be between 0 and 1.");
  }

  if (
    sourceRaw !== "LSP" &&
    sourceRaw !== "Agent" &&
    sourceRaw !== "User"
  ) {
    throw new Error("source must be one of: LSP, Agent, User.");
  }

  return {
    promptId: parsedPromptId,
    score: scoreRaw,
    source: sourceRaw,
    metadata: metadataRaw,
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
        },
        required: ["messy_text"],
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
      name: "record_feedback",
      description:
        "Records quality feedback for a stored refinement to improve memory relevance.",
      inputSchema: {
        type: "object",
        properties: {
          prompt_id: {
            type: "string",
            description: "Links back to the original SQLite prompt_history entry (as string id).",
          },
          score: {
            type: "number",
            description: "Float from 0 to 1 (0=failure, 0.5=needed tweaks, 1=perfect).",
          },
          source: {
            type: "string",
            enum: ["LSP", "Agent", "User"],
            description: "Feedback source.",
          },
          metadata: {
            type: "object",
            description: "JSON metadata such as error message or missing piece.",
          },
        },
        required: ["prompt_id", "score", "source"],
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
    const tokenDiffReport = buildTokenDiffReport(rawText, refinedText);

    return {
      content: [
        {
          type: "text",
          text: `Stored refinement successfully.\nPROMPT_ID: ${promptId}\n\n${tokenDiffReport}${notice}`,
        },
      ],
    };
  }

  if (request.params.name === "record_feedback") {
    try {
      const { promptId, score, source, metadata } = parseFeedbackArgs(
        request.params.arguments
      );
      recordFeedback(promptId, score, source, metadata);
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
