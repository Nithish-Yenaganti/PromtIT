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

export const promptItServer = new McpServer(
  { name: "prompt-refiner", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

type StoreArgs = {
  rawText: string;
  refinedText: string;
  taskId: string;
  executionToken: string;
};

type PromptItArgs = {
  messyText: string;
  strict: boolean;
};

type FeedbackArgs = {
  promptId: number;
  score: number;
  source: "LSP" | "Agent" | "User";
  taskId: string;
  executionToken: string;
  metadata?: unknown;
};

type NormalizeArgs = {
  messyText: string;
  convertedPrompt?: string;
  strict: boolean;
};

type RegenerateArgs = {
  taskId: string;
  executionToken: string;
  userFeedback?: string;
  convertedPrompt?: string;
};

type CommitArgs = {
  taskId: string;
  executionToken: string;
  finalPrompt?: string;
  destination?: string;
  score: number;
};

const MAX_TEXT_CHARS = 16000;
const MAX_METADATA_CHARS = 8000;
const DEFAULT_CHARS_PER_TOKEN = 4;
const EXECUTION_TOKEN_TTL_MS = 30 * 60 * 1000;

type RefinementSession = {
  taskId: string;
  executionToken: string;
  expiresAtMs: number;
  storeDone: boolean;
  feedbackDone: boolean;
  promptId?: number;
  rawText?: string;
  currentPrompt?: string;
  revisionCount: number;
  committed: boolean;
};

const refinementSessions = new Map<string, RefinementSession>();

function redactSensitiveText(input: string): { text: string; redacted: boolean } {
  let output = input;
  const patterns: Array<[RegExp, string]> = [
    [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
    [/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED_TOKEN]"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
    [/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/g, "Bearer [REDACTED_TOKEN]"],
  ];

  for (const [pattern, replacement] of patterns) {
    output = output.replace(pattern, replacement);
  }
  return { text: output, redacted: output !== input };
}

function sanitizeMetadataForStorage(input: unknown): {
  metadata: unknown;
  redacted: boolean;
  truncated: boolean;
} {
  if (input === undefined) {
    return { metadata: undefined, redacted: false, truncated: false };
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    serialized = String(input);
  }

  const redactedResult = redactSensitiveText(serialized);
  let safeText = redactedResult.text;
  let truncated = false;
  if (safeText.length > MAX_METADATA_CHARS) {
    safeText = `${safeText.slice(0, MAX_METADATA_CHARS)}...[TRUNCATED]`;
    truncated = true;
  }

  return {
    metadata: { sanitized: true, payload: safeText },
    redacted: redactedResult.redacted,
    truncated,
  };
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [taskId, session] of refinementSessions.entries()) {
    if (session.expiresAtMs <= now) {
      refinementSessions.delete(taskId);
    }
  }
}

function createSession(): RefinementSession {
  pruneExpiredSessions();
  const now = Date.now();
  const taskId = crypto.randomUUID();
  const executionToken = crypto.randomUUID();
  const session: RefinementSession = {
    taskId,
    executionToken,
    expiresAtMs: now + EXECUTION_TOKEN_TTL_MS,
    storeDone: false,
    feedbackDone: false,
    revisionCount: 0,
    committed: false,
  };
  refinementSessions.set(taskId, session);
  return session;
}

function validateSession(taskIdRaw: string, tokenRaw: string): RefinementSession {
  pruneExpiredSessions();
  const session = refinementSessions.get(taskIdRaw);
  if (!session) {
    fail(
      "ERR_PROMPT_IT_REQUIRED",
      "No active refinement session. Call prompt_it first to get a task_id and execution_token."
    );
  }
  if (session.executionToken !== tokenRaw) {
    fail("ERR_INVALID_EXECUTION_TOKEN", "execution_token is invalid for this task_id.");
  }
  if (session.expiresAtMs <= Date.now()) {
    refinementSessions.delete(taskIdRaw);
    fail("ERR_TOKEN_EXPIRED", "execution_token expired. Call prompt_it again.");
  }
  return session;
}

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

async function buildConversionContext(messyText: string): Promise<{
  examplesBlock: string;
  recallNotice: string;
  sensitiveNotice: string;
  conversionInput: string;
}> {
  const sanitizedMessy = redactSensitiveText(messyText);
  let examplesText = "";
  let recallNotice = "";
  try {
    const queryEmbedding = await getEmbedding(sanitizedMessy.text);
    examplesText = await getContextualExamples(sanitizedMessy.text, queryEmbedding);
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
      "Notice: embedding recall is unavailable, so recent refinements were used instead.";
  }

  const examplesBlock = examplesText || "No relevant refinement history found yet.";
  const sanitizedExamples = redactSensitiveText(examplesBlock);
  const sensitiveNotice =
    sanitizedMessy.redacted || sanitizedExamples.redacted
      ? "Notice: potential secrets were redacted before host-side refinement."
      : "";
  const conversionInput = [
    "MESSY_TEXT:",
    sanitizedMessy.text,
    "",
    "SIMILAR_REFINEMENTS:",
    sanitizedExamples.text,
    "",
    "HOST_TASK:",
    "Rewrite MESSY_TEXT into a clean, structured system prompt. Infer intent type and user seniority from the text, and adapt prompt depth/terminology accordingly. Return only the refined prompt text. Do not include schema/section headers unless explicitly requested. Do not run web search or any external tools before completing this refinement step.",
  ].join("\n");

  return {
    examplesBlock: sanitizedExamples.text,
    recallNotice,
    sensitiveNotice,
    conversionInput,
  };
}

function buildReviewPayload(args: {
  session: RefinementSession;
  originalPrompt: string;
  convertedPrompt?: string;
  status: "needs_host_refinement" | "ready_for_review" | "needs_regenerated_prompt" | "committed";
  conversionInput?: string;
  similarRefinements?: string;
  notices?: string[];
  regenerationInstruction?: string;
  destination?: string;
  promptId?: number;
  tokenReport?: string;
}) {
  const actions =
    args.status === "committed"
      ? []
      : args.convertedPrompt
        ? ["edit", "regenerate", "send"]
        : ["generate_converted_prompt"];

  return {
    protocol: "promptit.review.v1",
    status: args.status,
    task_id: args.session.taskId,
    execution_token: args.session.executionToken,
    token_ttl_seconds: Math.floor(
      Math.max(0, args.session.expiresAtMs - Date.now()) / 1000
    ),
    original_prompt: args.originalPrompt,
    converted_prompt: args.convertedPrompt ?? null,
    revision_count: args.session.revisionCount,
    plan: [
      {
        id: "review",
        label: args.convertedPrompt
          ? "Review converted prompt"
          : "Generate converted prompt from conversion_context",
        state: args.convertedPrompt ? "ready" : "waiting",
      },
      {
        id: "approve",
        label: "User may edit, regenerate, or send",
        state: args.convertedPrompt ? "available" : "blocked",
      },
    ],
    actions,
    tools: {
      regenerate: "regenerate_prompt",
      send: "commit_prompt",
    },
    conversion_context: args.conversionInput
      ? {
          payload: args.conversionInput,
          similar_refinements: args.similarRefinements ?? "",
          note:
            "Host agent should produce converted_prompt from this payload, then call normalize_prompt again with the same messy_text and converted_prompt or call regenerate_prompt with converted_prompt.",
        }
      : undefined,
    regeneration_instruction: args.regenerationInstruction,
    destination: args.destination,
    prompt_id: args.promptId,
    token_report: args.tokenReport,
    notices: args.notices?.filter(Boolean) ?? [],
  };
}

function jsonToolResult(payload: unknown) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function parseStoreArgs(input: unknown): StoreArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const rawText = args.raw_text;
  const refinedText = args.refined_text;
  const taskIdRaw = args.task_id;
  const executionTokenRaw = args.execution_token;

  if (typeof rawText !== "string" || !rawText.trim()) {
    throw new Error("raw_text must be a non-empty string.");
  }
  if (typeof refinedText !== "string" || !refinedText.trim()) {
    throw new Error("refined_text must be a non-empty string.");
  }
  if (rawText.length > MAX_TEXT_CHARS || refinedText.length > MAX_TEXT_CHARS) {
    throw new Error(`raw_text/refined_text cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }
  if (typeof taskIdRaw !== "string" || !taskIdRaw.trim()) {
    throw new Error("task_id must be a non-empty string.");
  }
  if (typeof executionTokenRaw !== "string" || !executionTokenRaw.trim()) {
    throw new Error("execution_token must be a non-empty string.");
  }

  return { rawText, refinedText, taskId: taskIdRaw, executionToken: executionTokenRaw };
}

function parsePromptItArgs(input: unknown): PromptItArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const messyTextRaw = args.messy_text;
  const strictRaw = args.strict;

  if (typeof messyTextRaw !== "string" || !messyTextRaw.trim()) {
    throw new Error("messy_text must be a non-empty string.");
  }
  if (messyTextRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`messy_text cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }

  if (strictRaw !== undefined && typeof strictRaw !== "boolean") {
    throw new Error("strict must be a boolean when provided.");
  }

  return { messyText: messyTextRaw, strict: strictRaw ?? true };
}

function parseNormalizeArgs(input: unknown): NormalizeArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const messyTextRaw = args.messy_text;
  const convertedPromptRaw = args.converted_prompt;
  const strictRaw = args.strict;

  if (typeof messyTextRaw !== "string" || !messyTextRaw.trim()) {
    throw new Error("messy_text must be a non-empty string.");
  }
  if (messyTextRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`messy_text cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }
  if (
    convertedPromptRaw !== undefined &&
    (typeof convertedPromptRaw !== "string" || !convertedPromptRaw.trim())
  ) {
    throw new Error("converted_prompt must be a non-empty string when provided.");
  }
  if (typeof convertedPromptRaw === "string" && convertedPromptRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`converted_prompt cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }
  if (strictRaw !== undefined && typeof strictRaw !== "boolean") {
    throw new Error("strict must be a boolean when provided.");
  }

  return {
    messyText: messyTextRaw,
    convertedPrompt: typeof convertedPromptRaw === "string" ? convertedPromptRaw : undefined,
    strict: strictRaw ?? true,
  };
}

function parseRegenerateArgs(input: unknown): RegenerateArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const taskIdRaw = args.task_id;
  const executionTokenRaw = args.execution_token;
  const userFeedbackRaw = args.user_feedback;
  const convertedPromptRaw = args.converted_prompt;

  if (typeof taskIdRaw !== "string" || !taskIdRaw.trim()) {
    throw new Error("task_id must be a non-empty string.");
  }
  if (typeof executionTokenRaw !== "string" || !executionTokenRaw.trim()) {
    throw new Error("execution_token must be a non-empty string.");
  }
  if (
    userFeedbackRaw !== undefined &&
    (typeof userFeedbackRaw !== "string" || !userFeedbackRaw.trim())
  ) {
    throw new Error("user_feedback must be a non-empty string when provided.");
  }
  if (typeof userFeedbackRaw === "string" && userFeedbackRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`user_feedback cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }
  if (
    convertedPromptRaw !== undefined &&
    (typeof convertedPromptRaw !== "string" || !convertedPromptRaw.trim())
  ) {
    throw new Error("converted_prompt must be a non-empty string when provided.");
  }
  if (typeof convertedPromptRaw === "string" && convertedPromptRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`converted_prompt cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }

  return {
    taskId: taskIdRaw,
    executionToken: executionTokenRaw,
    userFeedback: typeof userFeedbackRaw === "string" ? userFeedbackRaw : undefined,
    convertedPrompt: typeof convertedPromptRaw === "string" ? convertedPromptRaw : undefined,
  };
}

function parseCommitArgs(input: unknown): CommitArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const taskIdRaw = args.task_id;
  const executionTokenRaw = args.execution_token;
  const finalPromptRaw = args.final_prompt;
  const destinationRaw = args.destination;
  const scoreRaw = args.score;

  if (typeof taskIdRaw !== "string" || !taskIdRaw.trim()) {
    throw new Error("task_id must be a non-empty string.");
  }
  if (typeof executionTokenRaw !== "string" || !executionTokenRaw.trim()) {
    throw new Error("execution_token must be a non-empty string.");
  }
  if (
    finalPromptRaw !== undefined &&
    (typeof finalPromptRaw !== "string" || !finalPromptRaw.trim())
  ) {
    throw new Error("final_prompt must be a non-empty string when provided.");
  }
  if (typeof finalPromptRaw === "string" && finalPromptRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`final_prompt cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }
  if (
    destinationRaw !== undefined &&
    (typeof destinationRaw !== "string" || !destinationRaw.trim())
  ) {
    throw new Error("destination must be a non-empty string when provided.");
  }
  if (scoreRaw !== undefined && (typeof scoreRaw !== "number" || !Number.isFinite(scoreRaw))) {
    throw new Error("score must be a number between 0 and 1 when provided.");
  }
  const score = typeof scoreRaw === "number" ? scoreRaw : 1;
  if (score < 0 || score > 1) {
    throw new Error("score must be between 0 and 1.");
  }

  return {
    taskId: taskIdRaw,
    executionToken: executionTokenRaw,
    finalPrompt: typeof finalPromptRaw === "string" ? finalPromptRaw : undefined,
    destination: typeof destinationRaw === "string" ? destinationRaw : undefined,
    score,
  };
}

function parseFeedbackArgs(input: unknown): FeedbackArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const promptIdRaw = args.prompt_id;
  const scoreRaw = args.score;
  const sourceRaw = args.source;
  const taskIdRaw = args.task_id;
  const executionTokenRaw = args.execution_token;
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
  if (typeof taskIdRaw !== "string" || !taskIdRaw.trim()) {
    throw new Error("task_id must be a non-empty string.");
  }
  if (typeof executionTokenRaw !== "string" || !executionTokenRaw.trim()) {
    throw new Error("execution_token must be a non-empty string.");
  }

  return {
    promptId: parsedPromptId,
    score: scoreRaw,
    source: sourceRaw,
    taskId: taskIdRaw,
    executionToken: executionTokenRaw,
    metadata: metadataRaw,
  };
}

promptItServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
          strict: {
            type: "boolean",
            description:
              "When true (default), prompt_it returns enforcement metadata (task_id, execution_token, required_steps).",
          },
        },
        required: ["messy_text"],
      },
    },
    {
      name: "normalize_prompt",
      description:
        "Starts a tool-only PromptIT review session. Returns structured review data, conversion context, and edit/regenerate/send actions for the host UI.",
      inputSchema: {
        type: "object",
        properties: {
          messy_text: {
            type: "string",
            description: "The raw prompt the user wants normalized.",
          },
          converted_prompt: {
            type: "string",
            description:
              "Optional host-generated clean prompt. When present, the session is ready for user review.",
          },
          strict: {
            type: "boolean",
            description:
              "When true (default), includes task_id and execution_token for the review session.",
          },
        },
        required: ["messy_text"],
      },
    },
    {
      name: "regenerate_prompt",
      description:
        "Continues a PromptIT review session after the user asks for a different version. Returns regeneration context or stores a new host-generated converted prompt.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task id returned by normalize_prompt." },
          execution_token: {
            type: "string",
            description: "Execution token returned by normalize_prompt.",
          },
          user_feedback: {
            type: "string",
            description: "User instruction for the next version, such as shorter or more technical.",
          },
          converted_prompt: {
            type: "string",
            description:
              "Optional regenerated prompt produced by the host agent. When present, it becomes the current review draft.",
          },
        },
        required: ["task_id", "execution_token"],
      },
    },
    {
      name: "commit_prompt",
      description:
        "Approves the current PromptIT review draft, stores it in memory, records feedback, and returns the final prompt for the host to send.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Task id returned by normalize_prompt." },
          execution_token: {
            type: "string",
            description: "Execution token returned by normalize_prompt.",
          },
          final_prompt: {
            type: "string",
            description:
              "Optional user-edited final prompt. If omitted, the current converted_prompt is committed.",
          },
          destination: {
            type: "string",
            description: "Optional host destination label, for example codex or claude.",
          },
          score: {
            type: "number",
            description:
              "Optional approval score from 0 to 1. Defaults to 1 for explicit user approval.",
          },
        },
        required: ["task_id", "execution_token"],
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
          task_id: {
            type: "string",
            description: "Task id returned by prompt_it.",
          },
          execution_token: {
            type: "string",
            description: "Execution token returned by prompt_it.",
          },
        },
        required: ["raw_text", "refined_text", "task_id", "execution_token"],
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
          task_id: {
            type: "string",
            description: "Task id returned by prompt_it.",
          },
          execution_token: {
            type: "string",
            description: "Execution token returned by prompt_it.",
          },
        },
        required: ["prompt_id", "score", "source", "task_id", "execution_token"],
      },
    },
  ],
}));

promptItServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "prompt_it") {
    const { messyText, strict } = parsePromptItArgs(request.params.arguments);
    const { recallNotice, sensitiveNotice, conversionInput } = await buildConversionContext(
      messyText
    );

    const session = createSession();
    const strictMeta = strict
      ? [
          "",
          "ENFORCEMENT:",
          `TASK_ID: ${session.taskId}`,
          `EXECUTION_TOKEN: ${session.executionToken}`,
          `TOKEN_TTL_SECONDS: ${Math.floor(EXECUTION_TOKEN_TTL_MS / 1000)}`,
          "REQUIRED_STEPS: store_refinement -> record_feedback",
        ].join("\n")
      : "";

    return {
      content: [
        {
          type: "text",
          text: `${recallNotice ? `${recallNotice}\n\n` : ""}${
            sensitiveNotice ? `${sensitiveNotice}\n\n` : ""
          }${conversionInput}${strictMeta}`,
        },
      ],
    };
  }

  if (request.params.name === "normalize_prompt") {
    const { messyText, convertedPrompt, strict } = parseNormalizeArgs(
      request.params.arguments
    );
    const { recallNotice, sensitiveNotice, conversionInput, examplesBlock } =
      await buildConversionContext(messyText);
    const session = createSession();
    const sanitizedRaw = redactSensitiveText(messyText);
    const sanitizedConverted =
      convertedPrompt === undefined ? undefined : redactSensitiveText(convertedPrompt);
    session.rawText = sanitizedRaw.text;
    session.currentPrompt = sanitizedConverted?.text;
    session.revisionCount = convertedPrompt ? 1 : 0;

    const payload = buildReviewPayload({
      session,
      originalPrompt: sanitizedRaw.text,
      convertedPrompt: sanitizedConverted?.text,
      status: convertedPrompt ? "ready_for_review" : "needs_host_refinement",
      conversionInput,
      similarRefinements: examplesBlock,
      notices: [
        strict ? "" : "strict=false was accepted, but review sessions still require task credentials.",
        recallNotice,
        sensitiveNotice,
        sanitizedConverted?.redacted
          ? "Potential secrets were redacted from converted_prompt."
          : "",
      ],
    });

    return jsonToolResult(payload);
  }

  if (request.params.name === "regenerate_prompt") {
    const { taskId, executionToken, userFeedback, convertedPrompt } = parseRegenerateArgs(
      request.params.arguments
    );
    const session = validateSession(taskId, executionToken);
    if (!session.rawText) {
      fail(
        "ERR_FLOW_INVALID",
        "regenerate_prompt requires a review session created by normalize_prompt."
      );
    }
    if (session.committed) {
      fail("ERR_FLOW_INVALID", "This prompt review session has already been committed.");
    }

    const sanitizedConverted =
      convertedPrompt === undefined ? undefined : redactSensitiveText(convertedPrompt);
    if (sanitizedConverted) {
      session.currentPrompt = sanitizedConverted.text;
      session.revisionCount += 1;
    }

    const regenerationInstruction = [
      "Regenerate the converted prompt for the active PromptIT review session.",
      "",
      "ORIGINAL_PROMPT:",
      session.rawText,
      "",
      "CURRENT_CONVERTED_PROMPT:",
      session.currentPrompt ?? "No converted prompt has been accepted into the session yet.",
      "",
      "USER_FEEDBACK:",
      userFeedback ?? "No specific feedback provided. Produce a clearer alternative.",
      "",
      "Return only the regenerated prompt text. The host should then call regenerate_prompt again with converted_prompt set to that regenerated text.",
    ].join("\n");

    const payload = buildReviewPayload({
      session,
      originalPrompt: session.rawText,
      convertedPrompt: session.currentPrompt,
      status: sanitizedConverted ? "ready_for_review" : "needs_regenerated_prompt",
      regenerationInstruction,
      notices: [
        sanitizedConverted?.redacted
          ? "Potential secrets were redacted from converted_prompt."
          : "",
      ],
    });

    return jsonToolResult(payload);
  }

  if (request.params.name === "commit_prompt") {
    const { taskId, executionToken, finalPrompt, destination, score } = parseCommitArgs(
      request.params.arguments
    );
    const session = validateSession(taskId, executionToken);
    if (!session.rawText) {
      fail(
        "ERR_FLOW_INVALID",
        "commit_prompt requires a review session created by normalize_prompt."
      );
    }
    if (session.committed) {
      fail("ERR_FLOW_INVALID", "This prompt review session has already been committed.");
    }

    const promptToCommit = finalPrompt ?? session.currentPrompt;
    if (!promptToCommit?.trim()) {
      fail(
        "ERR_FLOW_INVALID",
        "No converted prompt is available. Provide final_prompt or regenerate a converted_prompt first."
      );
    }

    const sanitizedFinal = redactSensitiveText(promptToCommit);
    let embedding: number[] | null = null;
    const notices: string[] = [];
    try {
      embedding = await getEmbedding(session.rawText);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Embedding failed during commit_prompt: ${message}\n`);
      notices.push(
        "Saved without embedding due to runtime issue. Semantic recall may be limited until embeddings recover."
      );
    }

    const promptId = savePrompt(session.rawText, sanitizedFinal.text, embedding);
    const tokenReport = buildTokenDiffReport(session.rawText, sanitizedFinal.text);
    recordFeedback(promptId, score, "User", {
      source: "commit_prompt",
      destination: destination ?? "host",
      revision_count: session.revisionCount,
    });

    session.currentPrompt = sanitizedFinal.text;
    session.promptId = promptId;
    session.storeDone = true;
    session.feedbackDone = true;
    session.committed = true;
    refinementSessions.delete(taskId);

    if (sanitizedFinal.redacted) {
      notices.push("Potential secrets were redacted before persistence.");
    }

    const payload = buildReviewPayload({
      session,
      originalPrompt: session.rawText,
      convertedPrompt: sanitizedFinal.text,
      status: "committed",
      destination: destination ?? "host",
      promptId,
      tokenReport,
      notices,
    });

    return jsonToolResult({
      ...payload,
      final_prompt: sanitizedFinal.text,
      send_instruction:
        "Host should now send final_prompt to the selected destination. PromptIT does not own delivery.",
    });
  }

  if (request.params.name === "store_refinement") {
    const { rawText, refinedText, taskId, executionToken } = parseStoreArgs(
      request.params.arguments
    );
    const session = validateSession(taskId, executionToken);
    if (session.storeDone) {
      fail("ERR_FLOW_INVALID", "store_refinement has already been completed for this task.");
    }
    const sanitizedRaw = redactSensitiveText(rawText);
    const sanitizedRefined = redactSensitiveText(refinedText);
    let embedding: number[] | null = null;
    let notice = "";
    try {
      embedding = await getEmbedding(sanitizedRaw.text);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Embedding failed during store_refinement: ${message}\n`);
      notice =
        "\nNote: Saved without embedding due to runtime issue. Semantic recall may be limited until embeddings recover.";
    }

    const promptId = savePrompt(sanitizedRaw.text, sanitizedRefined.text, embedding);
    const tokenDiffReport = buildTokenDiffReport(rawText, refinedText);
    if (sanitizedRaw.redacted || sanitizedRefined.redacted) {
      notice +=
        "\nNote: potential secrets were redacted before persistence and embedding generation.";
    }
    session.storeDone = true;
    session.promptId = promptId;

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
      const { promptId, score, source, metadata, taskId, executionToken } = parseFeedbackArgs(
        request.params.arguments
      );
      const session = validateSession(taskId, executionToken);
      if (!session.storeDone) {
        fail(
          "ERR_FLOW_INVALID",
          "store_refinement must be completed before record_feedback."
        );
      }
      if (session.feedbackDone) {
        fail("ERR_FLOW_INVALID", "record_feedback has already been completed for this task.");
      }
      if (session.promptId && session.promptId !== promptId) {
        fail(
          "ERR_FLOW_INVALID",
          "prompt_id mismatch for this task. Use the prompt_id returned by store_refinement."
        );
      }
      const sanitizedMetadata = sanitizeMetadataForStorage(metadata);
      recordFeedback(promptId, score, source, sanitizedMetadata.metadata);
      session.feedbackDone = true;
      refinementSessions.delete(taskId);
      const metadataNotice =
        sanitizedMetadata.redacted || sanitizedMetadata.truncated
          ? " Metadata was sanitized before storage."
          : "";
      return {
        content: [
          {
            type: "text",
            text: `Feedback recorded. Prompt memory is updated. Task closed.${metadataNotice}`,
          },
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

let stdioStarted = false;

export async function startPromptItStdioServer(): Promise<void> {
  if (stdioStarted) return;
  const transport = new StdioServerTransport();
  await promptItServer.connect(transport);
  stdioStarted = true;
  startEmbeddingWarmup();
  process.stderr.write("MCP prompt-refiner server connected (stdio).\n");
}
