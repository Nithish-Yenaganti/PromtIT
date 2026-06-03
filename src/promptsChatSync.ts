import { createHash } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  GetPromptResultSchema,
  ListPromptsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { upsertTemplates, type TemplateRecord } from "./database";

const DEFAULT_PROMPTS_CHAT_MCP_URL = "https://prompts.chat/api/mcp";
const ALLOWED_MCP_URL_ENV = "PROMPTIT_ALLOWED_PROMPTS_CHAT_URLS";
const ALLOWED_MCP_ORIGIN_ENV = "PROMPTIT_ALLOWED_MCP_ORIGINS";

export type PromptsChatPromptItem = {
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
};

export type PromptsChatPromptContent = {
  description?: string;
  messages: Array<{
    role: string;
    content:
      | { type: "text"; text: string }
      | { type: string; [key: string]: unknown };
  }>;
};

export type PromptsChatSearchPrompt = {
  id: string;
  title?: string;
  description?: string;
  content?: string;
  type?: string;
  author?: string;
  category?: string;
  tags?: string[];
  votes?: number;
  createdAt?: string;
};

export type SyncPromptsChatOptions = {
  keywords?: string[];
  limit?: number;
  dryRun?: boolean;
  serverUrl?: string;
};

export type TemplateValidationError = {
  prompt_name: string;
  reason: string;
};

export type SyncPromptsChatResult = {
  source: "prompts.chat";
  dry_run: boolean;
  fetched_count: number;
  matched_count: number;
  imported_count: number;
  skipped_count: number;
  failed_count: number;
  templates: Array<{
    id: string;
    name: string;
    intent_type: string;
    task_type: string;
    quality_score: number;
  }>;
  errors: TemplateValidationError[];
};

type IntentConfig = {
  intent_type: string;
  domain: string;
  task_type: string;
  seniority_level: string;
  output_style: string;
  keywords: string[];
};

const DEFAULT_KEYWORDS = [
  "code review",
  "software implementation",
  "architecture planning",
  "technical research",
  "clear writing",
];

const INTENT_CONFIGS: IntentConfig[] = [
  {
    intent_type: "coding",
    domain: "software",
    task_type: "review",
    seniority_level: "advanced",
    output_style: "findings first",
    keywords: [
      "review",
      "audit",
      "bug",
      "bugs",
      "risk",
      "risks",
      "regression",
      "security",
      "performance",
      "maintainability",
      "quality",
    ],
  },
  {
    intent_type: "coding",
    domain: "software",
    task_type: "implementation",
    seniority_level: "intermediate",
    output_style: "concise implementation prompt",
    keywords: [
      "code",
      "coding",
      "fix",
      "repair",
      "debug",
      "implement",
      "implementation",
      "feature",
      "build",
      "test",
      "tests",
      "typescript",
      "javascript",
      "bun",
      "node",
      "repo",
      "repository",
      "branch",
      "commit",
      "push",
      "server",
      "runtime",
    ],
  },
  {
    intent_type: "planning",
    domain: "architecture",
    task_type: "architecture",
    seniority_level: "intermediate",
    output_style: "architecture decision record",
    keywords: [
      "architecture",
      "architect",
      "system",
      "design",
      "stack",
      "roadmap",
      "deploy",
      "deployment",
      "cloud",
      "local",
      "database",
      "scalability",
      "migration",
      "tradeoff",
      "tradeoffs",
    ],
  },
  {
    intent_type: "research",
    domain: "general",
    task_type: "research",
    seniority_level: "intermediate",
    output_style: "sourced answer",
    keywords: [
      "research",
      "latest",
      "current",
      "compare",
      "comparison",
      "source",
      "sources",
      "verify",
      "citation",
      "citations",
      "find",
      "lookup",
    ],
  },
  {
    intent_type: "writing",
    domain: "communication",
    task_type: "drafting",
    seniority_level: "beginner",
    output_style: "plain language",
    keywords: [
      "write",
      "writing",
      "explain",
      "email",
      "summary",
      "summarize",
      "docs",
      "documentation",
      "copy",
      "paragraph",
      "sentence",
      "rewrite",
      "edit",
    ],
  },
];

export async function syncPromptsChatTemplates(
  options: SyncPromptsChatOptions = {}
): Promise<SyncPromptsChatResult> {
  const serverUrl = resolvePromptsChatMcpUrl(
    options.serverUrl?.trim() ||
    process.env.PROMPTS_CHAT_MCP_URL?.trim() ||
    DEFAULT_PROMPTS_CHAT_MCP_URL
  );

  const keywords = normalizeKeywords(options.keywords);
  const limit = normalizeLimit(options.limit);
  const headers = buildHeaders();
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: headers ? { headers } : undefined,
  });
  const client = new Client(
    { name: "promptit-prompts-chat-sync", version: "1.0.0" },
    { capabilities: {} }
  );

  await client.connect(transport);
  try {
    const searchResults = await searchPrompts(client, keywords, limit);
    const prompts = searchResults.length > 0 ? searchResults : await listPrompts(client);
    const matched =
      searchResults.length > 0
        ? prompts.slice(0, limit ?? undefined)
        : filterPrompts(prompts as PromptsChatPromptItem[], keywords).slice(0, limit ?? undefined);
    const templates: TemplateRecord[] = [];
    const errors: TemplateValidationError[] = [];
    const seen = new Set<string>();

    for (const prompt of matched) {
      const promptName = getPromptName(prompt);
      try {
        const template =
          isSearchPrompt(prompt)
            ? normalizeSearchPromptToTemplate(prompt)
            : normalizePromptToTemplate(
                prompt,
                await getPromptContent(client, prompt)
              );
        const validation = validateTemplateRecord(template);
        if (validation.length > 0) {
          errors.push(
            ...validation.map((reason) => ({
              prompt_name: promptName,
              reason,
            }))
          );
          continue;
        }
        if (seen.has(template.id)) {
          errors.push({ prompt_name: promptName, reason: `Duplicate template id: ${template.id}` });
          continue;
        }
        seen.add(template.id);
        templates.push(template);
      } catch (error: unknown) {
        errors.push({
          prompt_name: promptName,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!options.dryRun && templates.length > 0) {
      upsertTemplates(templates);
    }

    return {
      source: "prompts.chat",
      dry_run: options.dryRun ?? false,
      fetched_count: prompts.length,
      matched_count: matched.length,
      imported_count: options.dryRun ? 0 : templates.length,
      skipped_count: matched.length - templates.length,
      failed_count: errors.length,
      templates: templates.map((template) => ({
        id: template.id,
        name: template.name,
        intent_type: template.intent_type,
        task_type: template.task_type,
        quality_score: template.quality_score,
      })),
      errors,
    };
  } finally {
    await transport.close();
  }
}

export function normalizePromptToTemplate(
  prompt: PromptsChatPromptItem,
  content: PromptsChatPromptContent
): TemplateRecord {
  const textBlocks = content.messages
    .map((message) => extractTextContent(message.content))
    .filter(Boolean);
  const fullText = textBlocks.join("\n\n").trim();
  const haystack = [
    prompt.name,
    prompt.title ?? "",
    prompt.description ?? "",
    content.description ?? "",
    fullText,
    ...(prompt.arguments ?? []).map((arg) => `${arg.name} ${arg.description ?? ""}`),
  ].join(" ");
  const intent = inferIntentConfig(haystack);
  const hash = hashContent([prompt.name, prompt.title ?? "", prompt.description ?? "", fullText].join("\n"));
  const tags = buildTags(haystack, intent);

  return {
    id: `prompts-chat.${slugify(prompt.name)}`,
    name: prompt.title?.trim() || humanizeName(prompt.name),
    description:
      prompt.description?.trim() ||
      content.description?.trim() ||
      `Imported prompts.chat template for ${intent.intent_type} tasks.`,
    source: "prompts.chat",
    version: hash.slice(0, 12),
    intent_type: intent.intent_type,
    domain: intent.domain,
    task_type: intent.task_type,
    tags: tags.join(","),
    seniority_level: intent.seniority_level,
    output_style: intent.output_style,
    instructions: buildDerivedInstructions({
      title: prompt.title?.trim() || humanizeName(prompt.name),
      description: prompt.description?.trim() || content.description?.trim(),
      category: intent.domain,
      tags,
      intent,
    }),
    expected_output: buildExpectedOutput(intent),
    quality_score: scoreTemplateQuality(prompt, content, fullText, tags),
  };
}

export function normalizeSearchPromptToTemplate(prompt: PromptsChatSearchPrompt): TemplateRecord {
  const haystack = [
    prompt.id,
    prompt.title ?? "",
    prompt.description ?? "",
    prompt.content ?? "",
    prompt.category ?? "",
    ...(prompt.tags ?? []),
  ].join(" ");
  const intent = inferIntentConfig(haystack);
  const tags = buildTags(haystack, intent, prompt.tags);
  const hash = hashContent(
    [prompt.id, prompt.title ?? "", prompt.description ?? "", prompt.category ?? "", tags.join(",")].join("\n")
  );

  return {
    id: `prompts-chat.${slugify(prompt.id)}`,
    name: prompt.title?.trim() || humanizeName(prompt.id),
    description:
      prompt.description?.trim() ||
      `prompts.chat ${prompt.category ?? intent.domain} template for ${intent.intent_type} tasks.`,
    source: "prompts.chat",
    version: hash.slice(0, 12),
    intent_type: intent.intent_type,
    domain: prompt.category?.trim().toLowerCase() || intent.domain,
    task_type: intent.task_type,
    tags: tags.join(","),
    seniority_level: intent.seniority_level,
    output_style: intent.output_style,
    instructions: buildDerivedInstructions({
      title: prompt.title?.trim() || humanizeName(prompt.id),
      description: prompt.description?.trim(),
      category: prompt.category,
      tags,
      intent,
    }),
    expected_output: buildExpectedOutput(intent),
    quality_score: scoreSearchPromptQuality(prompt, tags),
  };
}

export function validateTemplateRecord(template: TemplateRecord): string[] {
  const errors: string[] = [];
  const requiredTextFields: Array<keyof TemplateRecord> = [
    "id",
    "name",
    "description",
    "source",
    "version",
    "intent_type",
    "domain",
    "task_type",
    "tags",
    "seniority_level",
    "output_style",
    "instructions",
    "expected_output",
  ];
  for (const field of requiredTextFields) {
    if (typeof template[field] !== "string" || !String(template[field]).trim()) {
      errors.push(`${field} is required`);
    }
  }
  if (!Number.isFinite(template.quality_score) || template.quality_score < 0 || template.quality_score > 1) {
    errors.push("quality_score must be between 0 and 1");
  }
  return errors;
}

export function normalizeKeywords(input?: string[]): string[] {
  const fromEnv = process.env.PROMPTS_CHAT_KEYWORDS?.trim();
  const raw = input && input.length > 0 ? input : fromEnv ? fromEnv.split(",") : DEFAULT_KEYWORDS;
  return Array.from(
    new Set(raw.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean))
  );
}

export function resolvePromptsChatMcpUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("prompts.chat MCP URL must be a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new Error("prompts.chat MCP URL must use https.");
  }

  const normalized = normalizeUrl(url);
  const allowedUrls = new Set([
    DEFAULT_PROMPTS_CHAT_MCP_URL,
    ...parseCsvEnv(ALLOWED_MCP_URL_ENV).map((value) => normalizeAllowedUrl(value, ALLOWED_MCP_URL_ENV)),
  ]);
  const allowedOrigins = new Set([
    new URL(DEFAULT_PROMPTS_CHAT_MCP_URL).origin,
    ...parseCsvEnv(ALLOWED_MCP_ORIGIN_ENV).map((value) =>
      normalizeAllowedOrigin(value, ALLOWED_MCP_ORIGIN_ENV)
    ),
  ]);

  if (!allowedUrls.has(normalized) && !allowedOrigins.has(url.origin)) {
    throw new Error(
      `prompts.chat MCP URL is not allowed. Use ${DEFAULT_PROMPTS_CHAT_MCP_URL}, or set ${ALLOWED_MCP_URL_ENV}/${ALLOWED_MCP_ORIGIN_ENV} for trusted endpoints.`
    );
  }

  return normalized;
}

function normalizeLimit(limit?: number): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("limit must be a positive number.");
  return Math.floor(limit);
}

function parseCsvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function normalizeUrl(url: URL): string {
  url.hash = "";
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/g, "");
  }
  return url.toString();
}

function normalizeAllowedUrl(value: string, envName: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("must use https");
    return normalizeUrl(url);
  } catch {
    throw new Error(`${envName} contains an invalid HTTPS URL.`);
  }
}

function normalizeAllowedOrigin(value: string, envName: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("must use https");
    return url.origin;
  } catch {
    throw new Error(`${envName} contains an invalid HTTPS origin.`);
  }
}

function buildHeaders(): Record<string, string> | undefined {
  const bearer =
    process.env.PROMPTS_API_KEY?.trim() ||
    process.env.PROMPTS_CHAT_BEARER_TOKEN?.trim() ||
    process.env.PROMPTS_CHAT_API_KEY?.trim();
  if (!bearer) return undefined;
  return { Authorization: `Bearer ${bearer}` };
}

async function listPrompts(client: Client): Promise<PromptsChatPromptItem[]> {
  const prompts: PromptsChatPromptItem[] = [];
  let cursor: string | undefined;
  do {
    const result = (await client.request(
      { method: "prompts/list", params: cursor ? { cursor } : {} },
      ListPromptsResultSchema
    )) as { prompts: PromptsChatPromptItem[]; nextCursor?: string };
    prompts.push(...result.prompts);
    cursor = result.nextCursor;
  } while (cursor);
  return prompts;
}

async function searchPrompts(
  client: Client,
  queries: string[],
  limit?: number
): Promise<PromptsChatSearchPrompt[]> {
  const results: PromptsChatSearchPrompt[] = [];
  const seen = new Set<string>();
  const perQueryLimit = Math.min(50, Math.max(1, limit ?? 10));

  for (const query of queries) {
    const response = await client.request(
      {
        method: "tools/call",
        params: {
          name: "search_prompts",
          arguments: {
            query,
            limit: perQueryLimit,
          },
        },
      },
      CallToolResultSchema
    );
    for (const prompt of extractSearchPrompts(response)) {
      if (seen.has(prompt.id)) continue;
      seen.add(prompt.id);
      results.push(prompt);
      if (limit && results.length >= limit) return results;
    }
  }

  return results;
}

function extractSearchPrompts(result: unknown): PromptsChatSearchPrompt[] {
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  const fromStructured = parseSearchPayload(structured);
  if (fromStructured.length > 0) return fromStructured;

  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  for (const item of content) {
    if (item.type !== "text" || !item.text) continue;
    const parsed = safeJsonParse(item.text);
    const prompts = parseSearchPayload(parsed);
    if (prompts.length > 0) return prompts;
  }

  return [];
}

function parseSearchPayload(payload: unknown): PromptsChatSearchPrompt[] {
  if (!payload || typeof payload !== "object") return [];
  const maybePrompts = (payload as { prompts?: unknown }).prompts;
  if (!Array.isArray(maybePrompts)) return [];
  return maybePrompts
    .map((item) => normalizeSearchPayloadItem(item))
    .filter((item): item is PromptsChatSearchPrompt => item !== null);
}

function normalizeSearchPayloadItem(item: unknown): PromptsChatSearchPrompt | null {
  if (!item || typeof item !== "object") return null;
  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  if (!id) return null;
  return {
    id,
    title: typeof record.title === "string" ? record.title : undefined,
    description: typeof record.description === "string" ? record.description : undefined,
    content: typeof record.content === "string" ? record.content : undefined,
    type: typeof record.type === "string" ? record.type : undefined,
    author: typeof record.author === "string" ? record.author : undefined,
    category: typeof record.category === "string" ? record.category : undefined,
    tags: Array.isArray(record.tags)
      ? record.tags.filter((tag): tag is string => typeof tag === "string")
      : undefined,
    votes: typeof record.votes === "number" ? record.votes : undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : undefined,
  };
}

async function getPromptContent(
  client: Client,
  prompt: PromptsChatPromptItem
): Promise<PromptsChatPromptContent> {
  const requiredArgs = (prompt.arguments ?? []).filter((arg) => arg.required).map((arg) => arg.name);
  const args = Object.fromEntries(
    requiredArgs.map((name) => [name, process.env[`PROMPTS_CHAT_ARG_${name.toUpperCase()}`] ?? ""])
  );
  return (await client.request(
    { method: "prompts/get", params: { name: prompt.name, arguments: args } },
    GetPromptResultSchema
  )) as PromptsChatPromptContent;
}

function filterPrompts(
  prompts: PromptsChatPromptItem[],
  keywords: string[]
): PromptsChatPromptItem[] {
  if (keywords.length === 0) return prompts;
  return prompts.filter((prompt) => {
    const haystack = [
      prompt.name,
      prompt.title ?? "",
      prompt.description ?? "",
      ...(prompt.arguments ?? []).map((arg) => `${arg.name} ${arg.description ?? ""}`),
    ]
      .join(" ")
      .toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword));
  });
}

function inferIntentConfig(input: string): IntentConfig {
  const lower = input.toLowerCase();
  const fallback = INTENT_CONFIGS[0];
  if (!fallback) throw new Error("No intent configs are available.");
  const reviewConfig = INTENT_CONFIGS.find((config) => config.task_type === "review");
  if (
    reviewConfig &&
    /\b(review|audit)\b/.test(lower) &&
    /\b(code|coding|bug|bugs|test|tests|security|regression|risk|risks)\b/.test(lower)
  ) {
    return reviewConfig;
  }
  let best = fallback;
  let bestScore = -1;
  for (const config of INTENT_CONFIGS) {
    const score = config.keywords.filter((keyword) => lower.includes(keyword)).length;
    if (score > bestScore) {
      best = config;
      bestScore = score;
    }
  }
  return best;
}

function isSearchPrompt(
  prompt: PromptsChatPromptItem | PromptsChatSearchPrompt
): prompt is PromptsChatSearchPrompt {
  return "id" in prompt && !("name" in prompt);
}

function getPromptName(prompt: PromptsChatPromptItem | PromptsChatSearchPrompt): string {
  return "name" in prompt ? prompt.name : prompt.id;
}

function extractTextContent(content: PromptsChatPromptContent["messages"][number]["content"]): string {
  if (content.type !== "text") return "";
  const text = "text" in content ? content.text : "";
  return typeof text === "string" ? text.trim() : "";
}

function buildTags(input: string, intent: IntentConfig, sourceTags: string[] = []): string[] {
  const lower = input.toLowerCase();
  const keywordTags = intent.keywords.filter((keyword) => lower.includes(keyword));
  return Array.from(
    new Set(
      [intent.intent_type, intent.domain, intent.task_type, ...sourceTags, ...keywordTags]
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean)
    )
  ).slice(0, 12);
}

function buildDerivedInstructions(args: {
  title: string;
  description?: string;
  category?: string;
  tags: string[];
  intent: IntentConfig;
}): string {
  return [
    `Use the prompts.chat template "${args.title}" as routing and structure guidance.`,
    args.description ? `Template summary: ${args.description}` : "",
    args.category ? `Category: ${args.category}` : "",
    args.tags.length > 0 ? `Relevant tags: ${args.tags.join(", ")}` : "",
    `Rewrite the user's messy request as a ${args.intent.output_style}.`,
    "Preserve the user's concrete intent and avoid copying unrelated template content.",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildExpectedOutput(intent: IntentConfig): string {
  if (intent.task_type === "review") {
    return "A findings-first prompt with review scope, risk areas, and expected output format.";
  }
  if (intent.task_type === "architecture") {
    return "A practical architecture prompt with constraints, tradeoffs, risks, and next steps.";
  }
  if (intent.task_type === "research") {
    return "A source-aware research prompt with scope, freshness requirements, and citation expectations.";
  }
  if (intent.task_type === "drafting") {
    return "A clear writing prompt with audience, tone, format, and length constraints.";
  }
  return "A compact execution-ready prompt with objective, constraints, validation, and expected result.";
}

function scoreTemplateQuality(
  prompt: PromptsChatPromptItem,
  content: PromptsChatPromptContent,
  fullText: string,
  tags: string[]
): number {
  let score = 0.45;
  if (prompt.title?.trim()) score += 0.08;
  if (prompt.description?.trim() || content.description?.trim()) score += 0.12;
  if (fullText.length >= 160) score += 0.18;
  if (fullText.length >= 500) score += 0.08;
  if (tags.length >= 4) score += 0.06;
  if ((prompt.arguments ?? []).some((arg) => arg.description?.trim())) score += 0.03;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function scoreSearchPromptQuality(prompt: PromptsChatSearchPrompt, tags: string[]): number {
  let score = 0.45;
  if (prompt.title?.trim()) score += 0.08;
  if (prompt.description?.trim()) score += 0.12;
  if (prompt.category?.trim()) score += 0.07;
  if ((prompt.tags ?? []).length > 0) score += 0.08;
  if (tags.length >= 4) score += 0.05;
  if (typeof prompt.votes === "number") score += Math.min(0.15, Math.max(0, prompt.votes) / 500);
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function humanizeName(input: string): string {
  return input
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function hashContent(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
