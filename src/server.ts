import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getEmbedding, startEmbeddingWarmup } from "./memory/embeddings";
import { getContextualExamples } from "./memory/fewShot";
import { BASE_REFINER_PROMPT } from "./prompts/base";
import { refineWithLocalModel, startLocalRefinerWarmup } from "./memory/localRefiner";
import {
  createRefinementSession,
  editRefinementSession,
  getLatestHistoryPromptId,
  getRefinementSession,
  initDB,
  markRefinementAccepted,
  savePrompt,
  updateRefinementSession,
} from "./memory/db";
import { recordFeedback } from "./tools/recordFeedback";  

initDB();

const server = new McpServer(
  { name: "prompt-engineer", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

type FeedbackArgs = {
  promptId?: number;
  rating: -1 | 0 | 1;
  userEdits?: string;
};
type PromptArgs = { prompt: string };
type RetryArgs = { promptId: number; retryNote?: string };
type AcceptArgs = { promptId: number };
type EditArgs = { promptId: number; editedPrompt: string };

const MAX_PROMPT_CHARS = 16000;
const MAX_USER_EDITS_CHARS = 16000;
const MAX_RETRY_NOTE_CHARS = 2000;

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

  if (promptIdRaw !== undefined && (typeof promptIdRaw !== "number" || !Number.isInteger(promptIdRaw) || promptIdRaw <= 0)) {
    throw new Error("prompt_id must be a positive integer when provided.");
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
    promptId: promptIdRaw as number | undefined,
    rating: ratingRaw as -1 | 0 | 1,
    userEdits: userEditsRaw,
  };
}

function parsePromptArgs(input: unknown): PromptArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const rawPrompt = args.prompt;
  if (typeof rawPrompt !== "string" || !rawPrompt.trim()) {
    throw new Error("prompt must be a non-empty string.");
  }
  if (rawPrompt.length > MAX_PROMPT_CHARS) {
    throw new Error(`prompt exceeds ${MAX_PROMPT_CHARS} characters.`);
  }
  return { prompt: rawPrompt };
}

function parseRetryArgs(input: unknown): RetryArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const promptIdRaw = args.prompt_id;
  const retryNoteRaw = args.retry_note;

  if (typeof promptIdRaw !== "number" || !Number.isInteger(promptIdRaw) || promptIdRaw <= 0) {
    throw new Error("prompt_id must be a positive integer.");
  }
  if (retryNoteRaw !== undefined && typeof retryNoteRaw !== "string") {
    throw new Error("retry_note must be a string when provided.");
  }
  if (typeof retryNoteRaw === "string" && retryNoteRaw.length > MAX_RETRY_NOTE_CHARS) {
    throw new Error(`retry_note exceeds ${MAX_RETRY_NOTE_CHARS} characters.`);
  }

  return { promptId: promptIdRaw, retryNote: retryNoteRaw };
}

function parseAcceptArgs(input: unknown): AcceptArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const promptIdRaw = args.prompt_id;
  if (typeof promptIdRaw !== "number" || !Number.isInteger(promptIdRaw) || promptIdRaw <= 0) {
    throw new Error("prompt_id must be a positive integer.");
  }
  return { promptId: promptIdRaw };
}

function parseEditArgs(input: unknown): EditArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const promptIdRaw = args.prompt_id;
  const editedPromptRaw = args.edited_prompt;

  if (typeof promptIdRaw !== "number" || !Number.isInteger(promptIdRaw) || promptIdRaw <= 0) {
    throw new Error("prompt_id must be a positive integer.");
  }
  if (typeof editedPromptRaw !== "string" || !editedPromptRaw.trim()) {
    throw new Error("edited_prompt must be a non-empty string.");
  }
  if (editedPromptRaw.length > MAX_PROMPT_CHARS) {
    throw new Error(`edited_prompt exceeds ${MAX_PROMPT_CHARS} characters.`);
  }

  return { promptId: promptIdRaw, editedPrompt: editedPromptRaw };
}

function formatPreview(promptId: number, candidatePrompt: string): string {
  return [
    "Preview",
    "",
    candidatePrompt,
    "",
    `Actions: Accept | Regenerate | Edit (prompt_id: ${promptId})`,
  ].join("\n");
}

async function refineWithSampling(
  serverInstance: McpServer,
  rawPrompt: string,
  examples: string,
  retryNote?: string
): Promise<{ ok: true; refinedPrompt: string } | { ok: false; message: string }> {
  const retrySection =
    typeof retryNote === "string" && retryNote.trim()
      ? `\n\n### RETRY INSTRUCTION:\n${retryNote.trim()}`
      : "";

  const refinementRequest = BASE_REFINER_PROMPT
    .replace("{examples}", examples || "No history found yet.")
    .replace("{input}", `${rawPrompt}${retrySection}`);

  try {
    const sampled = await serverInstance.server.createMessage({
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
    return { ok: true, refinedPrompt: extractSampledText(sampled.content) };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Sampling failed, attempting local fallback: ${message}\n`);

    const localResult = await refineWithLocalModel(refinementRequest);
    if (localResult.ok) {
      return {
        ok: true,
        refinedPrompt: localResult.notice
          ? `${localResult.notice}\n\n${localResult.refinedPrompt}`
          : localResult.refinedPrompt,
      };
    }

    return { ok: false, message: `Unable to refine prompt. ${localResult.message}` };
  }
}

// This tells the AI what tools are available
server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "prompt_it",
      description: "Refines a messy user prompt and returns a review preview with accept/regenerate/edit actions.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The raw user input prompt" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "retry_refinement",
      description: "Regenerates the candidate prompt using optional retry guidance.",
      inputSchema: {
        type: "object",
        properties: {
          prompt_id: { type: "integer", description: "The ID returned by prompt_it." },
          retry_note: { type: "string", description: "How to improve the next candidate." },
        },
        required: ["prompt_id"],
      },
    },
    {
      name: "edit_refined_prompt",
      description: "Replaces the candidate prompt with a user-edited version for review.",
      inputSchema: {
        type: "object",
        properties: {
          prompt_id: { type: "integer", description: "The ID returned by prompt_it." },
          edited_prompt: { type: "string", description: "The manually edited candidate prompt." },
        },
        required: ["prompt_id", "edited_prompt"],
      },
    },
    {
      name: "accept_refined_prompt",
      description: "Accepts the candidate prompt, persists it to memory, and returns final prompt text only.",
      inputSchema: {
        type: "object",
        properties: {
          prompt_id: { type: "integer", description: "The ID returned by prompt_it." },
        },
        required: ["prompt_id"],
      },
    },

    // The Feedback tool
    {
      name: "record_feedback",
      description: "Records the user's reaction to a refined prompt to improve future refinements.",
      inputSchema: {
        type: "object",
        properties: {
          prompt_id: { type: "integer", description: "The ID of the prompt being rated. Optional when latest accepted prompt should be used." },
          rating: { type: "integer", description: "1 for good, -1 for bad, 0 for neutral." },
          user_edits: { type: "string", description: "The final version the user actually used (if they edited it)." },
        },
        required: ["rating"],
      },
    },
  ],
}));

// This is where the logic will eventually 
server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "prompt_it") {
    const { prompt: rawPrompt } = parsePromptArgs(request.params.arguments);
    const currentVector = await getEmbedding(rawPrompt);
    const examples = await getContextualExamples(rawPrompt, currentVector);
    const refined = await refineWithSampling(server, rawPrompt, examples || "");
    if (!refined.ok) {
      return {
        content: [{ type: "text", text: refined.message }],
        isError: true,
      };
    }

    const promptId = createRefinementSession(rawPrompt, refined.refinedPrompt);
    return {
      content: [{ type: "text", text: formatPreview(promptId, refined.refinedPrompt) }],
    };
  }
  if (request.params.name === "retry_refinement") {
    const { promptId, retryNote } = parseRetryArgs(request.params.arguments);
    const session = getRefinementSession(promptId);
    if (!session) {
      throw new Error(`No refinement session found for prompt_id ${promptId}.`);
    }
    if (session.status === "accepted") {
      throw new Error("This prompt is already accepted. Create a new prompt_it request for further changes.");
    }

    const currentVector = await getEmbedding(session.raw_prompt);
    const examples = await getContextualExamples(session.raw_prompt, currentVector);
    const refined = await refineWithSampling(server, session.raw_prompt, examples || "", retryNote);
    if (!refined.ok) {
      return {
        content: [{ type: "text", text: refined.message }],
        isError: true,
      };
    }

    updateRefinementSession(promptId, refined.refinedPrompt, retryNote);
    return {
      content: [{ type: "text", text: formatPreview(promptId, refined.refinedPrompt) }],
    };
  }
  if (request.params.name === "edit_refined_prompt") {
    const { promptId, editedPrompt } = parseEditArgs(request.params.arguments);
    const session = getRefinementSession(promptId);
    if (!session) {
      throw new Error(`No refinement session found for prompt_id ${promptId}.`);
    }
    if (session.status === "accepted") {
      throw new Error("This prompt is already accepted. Create a new prompt_it request for further changes.");
    }

    editRefinementSession(promptId, editedPrompt, "manual edit");
    return {
      content: [{ type: "text", text: formatPreview(promptId, editedPrompt) }],
    };
  }
  if (request.params.name === "accept_refined_prompt") {
    const { promptId } = parseAcceptArgs(request.params.arguments);
    const session = getRefinementSession(promptId);
    if (!session) {
      throw new Error(`No refinement session found for prompt_id ${promptId}.`);
    }

    if (session.status !== "accepted") {
      const embedding = await getEmbedding(session.raw_prompt);
      savePrompt(session.raw_prompt, session.candidate_prompt, embedding);
      markRefinementAccepted(promptId);
    }

    return {
      content: [{ type: "text", text: session.candidate_prompt }],
    };
  }
  if (request.params.name === "record_feedback") {
    try {
      const { promptId, rating, userEdits } = parseFeedbackArgs(request.params.arguments);
      const resolvedPromptId = promptId ?? getLatestHistoryPromptId();
      if (!resolvedPromptId) {
        throw new Error("No accepted prompt found to associate feedback with.");
      }
      recordFeedback(resolvedPromptId, rating, userEdits);
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
startLocalRefinerWarmup();

process.stderr.write("MCP server connected.\n");
