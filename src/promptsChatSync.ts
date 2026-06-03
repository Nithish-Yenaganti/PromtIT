import { createHash } from "crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { GetPromptResultSchema, ListPromptsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { upsertTemplates, type TemplateRecord } from "./database";

const DEFAULT_PROMPTS_CHAT_MCP_URL = "https://prompts.chat/api/mcp";

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
  "software",
  "developer",
  "engineering",
  "programming",
  "devops",
  "architecture",
  "research",
  "writing",
  "review",
  "documentation",
];

const INTENT_CONFIGS: IntentConfig[] = [
  {
    intent_type: "coding",
    domain: "software",
    task_type: "review",
    seniority_level: "advanced",
    output_style: "findings first",
    keywords: ["review", "audit", "bug", "risk", "regression", "security", "performance"],
  },
  {
    intent_type: "coding",
    domain: "software",
    task_type: "implementation",
    seniority_level: "intermediate",
    output_style: "concise implementation prompt",
    keywords: [
      "code",
      "fix",
      "implement",
      "build",
      "test",
      "typescript",
      "javascript",
      "repo",
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
    keywords: ["architecture", "system", "design", "stack", "roadmap", "deploy", "cloud", "local"],
  },
  {
    intent_type: "research",
    domain: "general",
    task_type: "research",
    seniority_level: "intermediate",
    output_style: "sourced answer",
    keywords: ["research", "latest", "compare", "source", "verify", "citation", "find"],
  },
  {
    intent_type: "writing",
    domain: "communication",
    task_type: "drafting",
    seniority_level: "beginner",
    output_style: "plain language",
    keywords: ["write", "explain", "email", "summary", "docs", "copy", "paragraph", "sentence"],
  },
];

export async function syncPromptsChatTemplates(
  options: SyncPromptsChatOptions = {}
): Promise<SyncPromptsChatResult> {
  const serverUrl =
    options.serverUrl?.trim() ||
    process.env.PROMPTS_CHAT_MCP_URL?.trim() ||
    DEFAULT_PROMPTS_CHAT_MCP_URL;

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
    const prompts = await listPrompts(client);
    const matched = filterPrompts(prompts, keywords).slice(0, limit ?? undefined);
    const templates: TemplateRecord[] = [];
    const errors: TemplateValidationError[] = [];
    const seen = new Set<string>();

    for (const prompt of matched) {
      try {
        const content = await getPromptContent(client, prompt);
        const template = normalizePromptToTemplate(prompt, content);
        const validation = validateTemplateRecord(template);
        if (validation.length > 0) {
          errors.push(
            ...validation.map((reason) => ({
              prompt_name: prompt.name,
              reason,
            }))
          );
          continue;
        }
        if (seen.has(template.id)) {
          errors.push({ prompt_name: prompt.name, reason: `Duplicate template id: ${template.id}` });
          continue;
        }
        seen.add(template.id);
        templates.push(template);
      } catch (error: unknown) {
        errors.push({
          prompt_name: prompt.name,
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
    instructions:
      fullText ||
      prompt.description?.trim() ||
      content.description?.trim() ||
      `Use this template to structure ${intent.intent_type} requests.`,
    expected_output: buildExpectedOutput(intent),
    quality_score: scoreTemplateQuality(prompt, content, fullText, tags),
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

function normalizeLimit(limit?: number): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("limit must be a positive number.");
  return Math.floor(limit);
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

function extractTextContent(content: PromptsChatPromptContent["messages"][number]["content"]): string {
  if (content.type !== "text") return "";
  const text = "text" in content ? content.text : "";
  return typeof text === "string" ? text.trim() : "";
}

function buildTags(input: string, intent: IntentConfig): string[] {
  const lower = input.toLowerCase();
  const keywordTags = intent.keywords.filter((keyword) => lower.includes(keyword));
  return Array.from(new Set([intent.intent_type, intent.domain, intent.task_type, ...keywordTags])).slice(0, 12);
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
