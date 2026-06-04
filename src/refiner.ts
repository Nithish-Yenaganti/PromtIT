import {
  DEFAULT_CHARS_PER_TOKEN,
  EXECUTION_TOKEN_TTL_MS,
  MAX_TEXT_CHARS,
  parsePositiveNumberEnv,
} from "./config";
import {
  bootstrapPromptsChatTemplates,
  shouldSyncCategoryMore,
  syncPromptsChatForCategory,
  syncPromptsChatTemplates,
} from "./promptsChatSync";
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

type SyncPromptsChatArgs = {
  keywords?: string[];
  category?: string;
  limit?: number;
  dryRun?: boolean;
  serverUrl?: string;
};

type BootstrapPromptsChatArgs = {
  templatesPerCategory?: number;
  dryRun?: boolean;
  serverUrl?: string;
  force?: boolean;
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
        "Starts or updates a tool-only PromptIT review session. Selects a template and returns host-LLM refinement context plus edit/regenerate/send actions.",
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
    {
      name: "sync_prompts_chat",
      description:
        "Fetches prompts.chat templates, normalizes them into PromptIT template records, validates them, dedupes them, and upserts valid templates into the local SQLite cache.",
      inputSchema: {
        type: "object",
        properties: {
          keywords: {
            oneOf: [
              { type: "array", items: { type: "string" } },
              { type: "string" },
            ],
            description:
              "Optional keywords used to filter prompts before import. Defaults to PROMPTS_CHAT_KEYWORDS or PromptIT's built-in template keywords.",
          },
          limit: {
            type: "number",
            description: "Optional maximum number of matched prompts to fetch and normalize.",
          },
          category: {
            type: "string",
            description:
              "Optional prompts.chat category slug to filter search_prompts, for example coding or technical-writing.",
          },
          dry_run: {
            type: "boolean",
            description: "When true, validates and summarizes templates without writing to SQLite.",
          },
          server_url: {
            type: "string",
            description:
              "Optional prompts.chat MCP URL. Defaults to PROMPTS_CHAT_MCP_URL or https://prompts.chat/api/mcp.",
          },
        },
      },
    },
    {
      name: "bootstrap_prompts_chat",
      description:
        "Seeds PromptIT with a small prompts.chat starter set: 1 template per public category by default, plus optional forced retry.",
      inputSchema: {
        type: "object",
        properties: {
          templates_per_category: {
            type: "number",
            description: "Templates to import per category. Defaults to 1.",
          },
          dry_run: {
            type: "boolean",
            description: "When true, validates and summarizes without writing to SQLite.",
          },
          server_url: {
            type: "string",
            description:
              "Optional prompts.chat MCP URL. Must be HTTPS and allowed by PromptIT URL allowlist.",
          },
          force: {
            type: "boolean",
            description: "When true, sync categories even if they were already bootstrapped.",
          },
        },
      },
    },
  ];
}

export async function handlePromptItToolCall(name: string, args: unknown) {
  if (name === "normalize_prompt") return handleNormalizePrompt(args);
  if (name === "regenerate_prompt") return handleRegeneratePrompt(args);
  if (name === "commit_prompt") return handleCommitPrompt(args);
  if (name === "sync_prompts_chat") return handleSyncPromptsChat(args);
  if (name === "bootstrap_prompts_chat") return handleBootstrapPromptsChat(args);
  throw new Error("Tool not found");
}

async function handleSyncPromptsChat(input: unknown) {
  const { keywords, category, limit, dryRun, serverUrl } = parseSyncPromptsChatArgs(input);
  const result = await syncPromptsChatTemplates({
    keywords,
    category,
    limit,
    dryRun,
    serverUrl,
  });
  return jsonToolResult(result);
}

async function handleBootstrapPromptsChat(input: unknown) {
  const { templatesPerCategory, dryRun, serverUrl, force } = parseBootstrapPromptsChatArgs(input);
  const result = await bootstrapPromptsChatTemplates({
    templatesPerCategory,
    dryRun,
    serverUrl,
    force,
  });
  return jsonToolResult(result);
}

function handleNormalizePrompt(input: unknown) {
  const { messyText, convertedPrompt, taskId, executionToken } = parseNormalizeArgs(input);
  const existingSession =
    taskId && executionToken ? validateSession(taskId, executionToken) : undefined;
  const session = existingSession ?? createSession();
  const { sensitiveNotice, conversionInput, templateMatch } = buildConversionContext(
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
      originalPrompt: sanitizedRaw.text,
      convertedPrompt: sanitizedConverted?.text,
      status: convertedPrompt ? "ready_for_review" : "needs_host_refinement",
      conversionInput,
      templateMatch,
      notices: [
        sensitiveNotice,
        sanitizedConverted?.redacted
          ? "Potential secrets were redacted from converted_prompt."
          : "",
      ],
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
      originalPrompt: session.rawText,
      convertedPrompt: session.currentPrompt,
      status: sanitizedConverted ? "ready_for_review" : "needs_regenerated_prompt",
      regenerationInstruction,
      templateMatch: session.templateMatch,
      notices: [
        sanitizedConverted?.redacted
          ? "Potential secrets were redacted from converted_prompt."
          : "",
      ],
    })
  );
}

function handleCommitPrompt(input: unknown) {
  const { taskId, executionToken, finalPrompt, destination } = parseCommitArgs(input);
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
  const notices: string[] = [];
  const tokenReport = buildTokenDiffReport(session.rawText, sanitizedFinal.text);
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

  if (sanitizedFinal.redacted) {
    notices.push("Potential secrets were redacted before persistence.");
  }

  return jsonToolResult({
    ...buildReviewPayload({
      session,
      originalPrompt: session.rawText,
      convertedPrompt: sanitizedFinal.text,
      status: "committed",
      destination: destination ?? "host",
      tokenReport,
      templateMatch: session.templateMatch,
      notices,
    }),
    final_prompt: sanitizedFinal.text,
    send_instruction:
      "Host should now send final_prompt to the selected destination. PromptIT does not own delivery.",
  });
}

function buildConversionContext(messyText: string, existingMatch?: TemplateMatch): {
  sensitiveNotice: string;
  conversionInput: string;
  templateMatch: TemplateMatch;
} {
  const sanitizedMessy = redactSensitiveText(messyText);
  const templateMatch = existingMatch ?? selectBestTemplate(sanitizedMessy.text);
  const sensitiveNotice = sanitizedMessy.redacted
    ? "Notice: potential secrets were redacted before host-side refinement."
    : "";
  const conversionInput = [
    "MESSY_TEXT:",
    sanitizedMessy.text,
    "",
    "SELECTED_TEMPLATE:",
    `id: ${templateMatch.template.id}`,
    `name: ${templateMatch.template.name}`,
    `source: ${templateMatch.template.source}`,
    `intent_type: ${templateMatch.template.intent_type}`,
    `domain: ${templateMatch.template.domain}`,
    `task_type: ${templateMatch.template.task_type}`,
    `seniority_level: ${templateMatch.template.seniority_level}`,
    `output_style: ${templateMatch.template.output_style}`,
    `tags: ${templateMatch.template.tags}`,
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
    sensitiveNotice,
    conversionInput,
    templateMatch,
  };
}

function buildReviewPayload(args: {
  session: RefinementSession;
  originalPrompt: string;
  convertedPrompt?: string;
  status: ReviewStatus;
  conversionInput?: string;
  templateMatch?: TemplateMatch;
  notices?: string[];
  regenerationInstruction?: string;
  destination?: string;
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
    selected_template: args.templateMatch
      ? {
          id: args.templateMatch.template.id,
          name: args.templateMatch.template.name,
          source: args.templateMatch.template.source,
          intent_type: args.templateMatch.template.intent_type,
          domain: args.templateMatch.template.domain,
          task_type: args.templateMatch.template.task_type,
          score: Number(args.templateMatch.score.toFixed(4)),
          reasons: args.templateMatch.reasons,
        }
      : undefined,
    conversion_context: args.conversionInput
      ? {
          payload: args.conversionInput,
          selected_template: args.templateMatch?.template ?? null,
          note:
            "Host LLM should produce converted_prompt from this payload, then call normalize_prompt again with task_id, execution_token, messy_text, and converted_prompt.",
        }
      : undefined,
    regeneration_instruction: args.regenerationInstruction,
    destination: args.destination,
    token_report: args.tokenReport,
    notices: args.notices?.filter(Boolean) ?? [],
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

function parseSyncPromptsChatArgs(input: unknown): SyncPromptsChatArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const keywordsRaw = args.keywords;
  const limitRaw = args.limit;
  const categoryRaw = args.category;
  const dryRunRaw = args.dry_run;
  const serverUrlRaw = args.server_url;

  let keywords: string[] | undefined;
  if (typeof keywordsRaw === "string") {
    keywords = keywordsRaw
      .split(",")
      .map((keyword) => keyword.trim())
      .filter(Boolean);
  } else if (Array.isArray(keywordsRaw)) {
    if (!keywordsRaw.every((keyword) => typeof keyword === "string" && keyword.trim())) {
      throw new Error("keywords must contain only non-empty strings.");
    }
    keywords = keywordsRaw.map((keyword) => keyword.trim());
  } else if (keywordsRaw !== undefined) {
    throw new Error("keywords must be a string or an array of strings when provided.");
  }

  if (limitRaw !== undefined && (typeof limitRaw !== "number" || !Number.isFinite(limitRaw))) {
    throw new Error("limit must be a finite number when provided.");
  }
  if (limitRaw !== undefined && limitRaw <= 0) {
    throw new Error("limit must be greater than 0 when provided.");
  }
  if (dryRunRaw !== undefined && typeof dryRunRaw !== "boolean") {
    throw new Error("dry_run must be a boolean when provided.");
  }
  assertOptionalString(categoryRaw, "category");
  assertOptionalString(serverUrlRaw, "server_url");

  return {
    keywords,
    category: typeof categoryRaw === "string" ? categoryRaw : undefined,
    limit: typeof limitRaw === "number" ? Math.floor(limitRaw) : undefined,
    dryRun: typeof dryRunRaw === "boolean" ? dryRunRaw : undefined,
    serverUrl: typeof serverUrlRaw === "string" ? serverUrlRaw : undefined,
  };
}

function parseBootstrapPromptsChatArgs(input: unknown): BootstrapPromptsChatArgs {
  const args = (input ?? {}) as Record<string, unknown>;
  const templatesPerCategoryRaw = args.templates_per_category;
  const dryRunRaw = args.dry_run;
  const serverUrlRaw = args.server_url;
  const forceRaw = args.force;

  assertOptionalString(serverUrlRaw, "server_url");
  if (templatesPerCategoryRaw !== undefined && typeof templatesPerCategoryRaw !== "number") {
    throw new Error("templates_per_category must be a number.");
  }
  if (dryRunRaw !== undefined && typeof dryRunRaw !== "boolean") {
    throw new Error("dry_run must be a boolean.");
  }
  if (forceRaw !== undefined && typeof forceRaw !== "boolean") {
    throw new Error("force must be a boolean.");
  }

  return {
    templatesPerCategory:
      typeof templatesPerCategoryRaw === "number" ? templatesPerCategoryRaw : undefined,
    dryRun: typeof dryRunRaw === "boolean" ? dryRunRaw : undefined,
    serverUrl: typeof serverUrlRaw === "string" ? serverUrlRaw : undefined,
    force: typeof forceRaw === "boolean" ? forceRaw : undefined,
  };
}

function scheduleAdaptiveCategorySync(template: TemplateMatch["template"] | undefined): void {
  if (!template) return;
  const category = templateAdaptiveCategory(template);
  if (!shouldSyncCategoryMore(category)) return;

  syncPromptsChatForCategory(category).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`PromptIT adaptive prompts.chat sync skipped: ${message}\n`);
  });
}

function templateAdaptiveCategory(template: TemplateMatch["template"]): string {
  const domain = template.domain.trim().toLowerCase();
  if (domain === "software") return "coding";
  if (domain === "communication") return "writing";
  if (domain === "architecture") return "business-strategy";
  return domain || template.intent_type;
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

function estimateTokens(text: string): number {
  const normalizedLength = text.trim().length;
  if (normalizedLength <= 0) return 0;
  return Math.ceil(normalizedLength / DEFAULT_CHARS_PER_TOKEN);
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(6)}`;
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
