import {
  EXECUTION_TOKEN_TTL_MS,
  MAX_TEXT_CHARS,
} from "./config";
import { scheduleAdaptiveCategorySync } from "./adaptiveSync";
import {
  recordTemplateCategoryStat,
  recordTemplateStat,
  selectBestTemplate,
  type TemplateMatch,
} from "./templates";

type NormalizeArgs = {
  messyText: string;
  convertedPrompt?: string;
  taskId?: string;
  executionToken?: string;
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
};

type RefinementSession = {
  taskId: string;
  executionToken: string;
  expiresAtMs: number;
  rawText?: string;
  currentPrompt?: string;
  templateId?: string;
  templateName?: string;
  templateMatch?: TemplateMatch;
  revisionCount: number;
  committed: boolean;
};

type ReviewStatus =
  | "needs_host_refinement"
  | "ready_for_review"
  | "needs_regenerated_prompt"
  | "committed";

const refinementSessions = new Map<string, RefinementSession>();

export function getPromptItToolDefinitions() {
  return [
    {
      name: "normalize_prompt",
      description:
        "Starts or updates a tool-only PromptIT review session. Selects a template and returns host-LLM refinement context plus machine-readable review state.",
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
          task_id: {
            type: "string",
            description:
              "Optional existing review task id. Use with execution_token when returning a host-generated converted_prompt.",
          },
          execution_token: {
            type: "string",
            description:
              "Optional existing execution token. Use with task_id when returning a host-generated converted_prompt.",
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
        "Approves the current PromptIT review draft, records aggregate template stats, and returns the final prompt for the host to send.",
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
        },
        required: ["task_id", "execution_token"],
      },
    },
  ];
}

export async function handlePromptItToolCall(name: string, args: unknown) {
  if (name === "normalize_prompt") return handleNormalizePrompt(args);
  if (name === "regenerate_prompt") return handleRegeneratePrompt(args);
  if (name === "commit_prompt") return handleCommitPrompt(args);
  throw new Error("Tool not found");
}

function handleNormalizePrompt(input: unknown) {
  const { messyText, convertedPrompt, taskId, executionToken } = parseNormalizeArgs(input);
  const existingSession =
    taskId && executionToken ? validateSession(taskId, executionToken) : undefined;
  const session = existingSession ?? createSession();
  const { conversionInput, templateMatch } = buildConversionContext(
    messyText,
    existingSession?.templateMatch
  );
  const sanitizedRaw = redactSensitiveText(messyText);
  const sanitizedConverted =
    convertedPrompt === undefined ? undefined : redactSensitiveText(convertedPrompt);
  session.rawText = sanitizedRaw.text;
  session.currentPrompt = sanitizedConverted?.text;
  session.templateId = templateMatch.template.id;
  session.templateName = templateMatch.template.name;
  session.templateMatch = templateMatch;
  session.revisionCount = convertedPrompt
    ? Math.max(1, existingSession ? session.revisionCount + 1 : 1)
    : session.revisionCount;

  return jsonToolResult(
    buildReviewPayload({
      session,
      convertedPrompt: sanitizedConverted?.text,
      status: convertedPrompt ? "ready_for_review" : "needs_host_refinement",
      conversionInput,
      templateMatch,
    })
  );
}

function handleRegeneratePrompt(input: unknown) {
  const { taskId, executionToken, userFeedback, convertedPrompt } = parseRegenerateArgs(input);
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
  if (!session.templateId) {
    fail("ERR_FLOW_INVALID", "No selected template is attached to this review session.");
  }

  const sanitizedConverted =
    convertedPrompt === undefined ? undefined : redactSensitiveText(convertedPrompt);
  if (sanitizedConverted) {
    session.currentPrompt = sanitizedConverted.text;
    session.revisionCount += 1;
    recordTemplateStat(session.templateId, "regenerated");
    recordTemplateCategoryStat(session.templateMatch?.template, "regenerated");
  } else {
    recordTemplateStat(session.templateId, "regenerated");
    recordTemplateCategoryStat(session.templateMatch?.template, "regenerated");
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
    "SELECTED_TEMPLATE:",
    `${session.templateName ?? session.templateId}`,
    "",
    "USER_FEEDBACK:",
    userFeedback ?? "No specific feedback provided. Produce a clearer alternative.",
    "",
    "Return only the regenerated prompt text. The host should then call regenerate_prompt again with converted_prompt set to that regenerated text.",
  ].join("\n");

  return jsonToolResult(
    buildReviewPayload({
      session,
      convertedPrompt: session.currentPrompt,
      status: sanitizedConverted ? "ready_for_review" : "needs_regenerated_prompt",
      regenerationInstruction,
      templateMatch: session.templateMatch,
    })
  );
}

function handleCommitPrompt(input: unknown) {
  const { taskId, executionToken, finalPrompt } = parseCommitArgs(input);
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
  if (!session.templateId) {
    fail("ERR_FLOW_INVALID", "No selected template is attached to this review session.");
  }

  const sanitizedFinal = redactSensitiveText(promptToCommit);
  const wasEdited = session.currentPrompt !== undefined && sanitizedFinal.text !== session.currentPrompt;
  recordTemplateStat(session.templateId, "accepted");
  recordTemplateStat(session.templateId, "executed");
  recordTemplateCategoryStat(session.templateMatch?.template, "accepted");
  recordTemplateCategoryStat(session.templateMatch?.template, "executed");
  if (wasEdited) {
    recordTemplateStat(session.templateId, "edited");
    recordTemplateCategoryStat(session.templateMatch?.template, "edited");
  }
  scheduleAdaptiveCategorySync(session.templateMatch?.template);

  session.currentPrompt = sanitizedFinal.text;
  session.committed = true;
  refinementSessions.delete(taskId);

  return jsonToolResult({
    protocol: "promptit.review.v1",
    status: "committed",
    final_prompt: sanitizedFinal.text,
    template_citation: buildTemplateCitation(session.templateMatch),
  });
}

function buildConversionContext(messyText: string, existingMatch?: TemplateMatch): {
  conversionInput: string;
  templateMatch: TemplateMatch;
} {
  const sanitizedMessy = redactSensitiveText(messyText);
  const templateMatch = existingMatch ?? selectBestTemplate(sanitizedMessy.text);
  const conversionInput = [
    "MESSY_TEXT:",
    sanitizedMessy.text,
    "",
    "TEMPLATE_CITATION:",
    `source: ${templateMatch.template.source}`,
    `name: ${templateMatch.template.name}`,
    "",
    "TEMPLATE_INSTRUCTIONS:",
    templateMatch.template.instructions,
    "",
    "EXPECTED_OUTPUT:",
    templateMatch.template.expected_output,
    "",
    "HOST_TASK:",
    "Use SELECTED_TEMPLATE to rewrite MESSY_TEXT into a clean, structured prompt. Return only the refined prompt text. Do not execute the user's task. Do not add unrelated requirements.",
  ].join("\n");

  return {
    conversionInput,
    templateMatch,
  };
}

function buildReviewPayload(args: {
  session: RefinementSession;
  convertedPrompt?: string;
  status: ReviewStatus;
  conversionInput?: string;
  templateMatch?: TemplateMatch;
  regenerationInstruction?: string;
}) {
  if (args.status === "ready_for_review" && args.convertedPrompt) {
    return {
      protocol: "promptit.review.v1",
      status: args.status,
      converted_prompt: args.convertedPrompt,
      template_citation: buildTemplateCitation(args.templateMatch),
    };
  }

  return {
    protocol: "promptit.review.v1",
    status: args.status,
    task_id: args.session.taskId,
    execution_token: args.session.executionToken,
    host_instruction: args.conversionInput ?? args.regenerationInstruction ?? "",
  };
}

function buildTemplateCitation(match: TemplateMatch | undefined):
  | { source: string; name: string }
  | undefined {
  if (!match) return undefined;
  return {
    source: match.template.source,
    name: match.template.name,
  };
}

function redactSensitiveText(input: string): { text: string; redacted: boolean } {
  let output = input;
  const patterns: Array<[RegExp, string]> = [
    [/\bsk-proj-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_OPENAI_PROJECT_KEY]"],
    [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]"],
    [/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED_TOKEN]"],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
    [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_ACCESS_KEY]"],
    [/\bAIza[0-9A-Za-z_-]{30,}\b/g, "[REDACTED_GOOGLE_API_KEY]"],
    [/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, "[REDACTED_SLACK_TOKEN]"],
    [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    ],
    [/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/g, "Bearer [REDACTED_TOKEN]"],
    [
      /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Z0-9_]*)\s*=\s*["']?[^"'\s]{8,}["']?/gi,
      "$1=[REDACTED_SECRET]",
    ],
  ];

  for (const [pattern, replacement] of patterns) {
    output = output.replace(pattern, replacement);
  }
  return { text: output, redacted: output !== input };
}

function pruneExpiredSessions(): void {
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
      "No active refinement session. Call normalize_prompt first to get a task_id and execution_token."
    );
  }
  if (session.executionToken !== tokenRaw) {
    fail("ERR_INVALID_EXECUTION_TOKEN", "execution_token is invalid for this task_id.");
  }
  if (session.expiresAtMs <= Date.now()) {
    refinementSessions.delete(taskIdRaw);
    fail("ERR_TOKEN_EXPIRED", "execution_token expired. Call normalize_prompt again.");
  }
  return session;
}

function parseNormalizeArgs(input: unknown): NormalizeArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const messyTextRaw = args.messy_text;
  const convertedPromptRaw = args.converted_prompt;
  const taskIdRaw = args.task_id;
  const executionTokenRaw = args.execution_token;

  assertString(messyTextRaw, "messy_text");
  assertOptionalString(convertedPromptRaw, "converted_prompt");
  assertOptionalString(taskIdRaw, "task_id");
  assertOptionalString(executionTokenRaw, "execution_token");
  if ((taskIdRaw && !executionTokenRaw) || (!taskIdRaw && executionTokenRaw)) {
    throw new Error("task_id and execution_token must be provided together.");
  }
  if (messyTextRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`messy_text cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }
  if (typeof convertedPromptRaw === "string" && convertedPromptRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`converted_prompt cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }

  return {
    messyText: messyTextRaw,
    convertedPrompt: typeof convertedPromptRaw === "string" ? convertedPromptRaw : undefined,
    taskId: typeof taskIdRaw === "string" ? taskIdRaw : undefined,
    executionToken: typeof executionTokenRaw === "string" ? executionTokenRaw : undefined,
  };
}

function parseRegenerateArgs(input: unknown): RegenerateArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const taskIdRaw = args.task_id;
  const executionTokenRaw = args.execution_token;
  const userFeedbackRaw = args.user_feedback;
  const convertedPromptRaw = args.converted_prompt;

  assertString(taskIdRaw, "task_id");
  assertString(executionTokenRaw, "execution_token");
  assertOptionalString(userFeedbackRaw, "user_feedback");
  assertOptionalString(convertedPromptRaw, "converted_prompt");
  if (typeof userFeedbackRaw === "string" && userFeedbackRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`user_feedback cannot exceed ${MAX_TEXT_CHARS} characters.`);
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

  assertString(taskIdRaw, "task_id");
  assertString(executionTokenRaw, "execution_token");
  assertOptionalString(finalPromptRaw, "final_prompt");
  assertOptionalString(destinationRaw, "destination");
  if (typeof finalPromptRaw === "string" && finalPromptRaw.length > MAX_TEXT_CHARS) {
    throw new Error(`final_prompt cannot exceed ${MAX_TEXT_CHARS} characters.`);
  }

  return {
    taskId: taskIdRaw,
    executionToken: executionTokenRaw,
    finalPrompt: typeof finalPromptRaw === "string" ? finalPromptRaw : undefined,
    destination: typeof destinationRaw === "string" ? destinationRaw : undefined,
  };
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function assertOptionalString(value: unknown, name: string): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    throw new Error(`${name} must be a non-empty string when provided.`);
  }
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

function textToolResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function jsonToolResult(payload: unknown) {
  return textToolResult(JSON.stringify(payload, null, 2));
}
