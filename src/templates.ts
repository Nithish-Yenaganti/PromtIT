import {
  getTemplateStats,
  listTemplates,
  recordCategoryEvent,
  recordTemplateEvent,
  type TemplateRecord,
  type TemplateStats,
  type TemplateStatsEvent,
} from "./database";

export type TemplateMatch = {
  template: TemplateRecord;
  stats: TemplateStats;
  score: number;
  reasons: string[];
  inferred_intent_type: string;
};

type IntentRule = {
  intent: string;
  keywords: string[];
};

const INTENT_RULES: IntentRule[] = [
  {
    intent: "coding",
    keywords: [
      "code",
      "bug",
      "fix",
      "implement",
      "repo",
      "branch",
      "build",
      "test",
      "typescript",
      "javascript",
      "mcp",
      "server",
      "runtime",
    ],
  },
  {
    intent: "planning",
    keywords: [
      "plan",
      "architecture",
      "design",
      "system",
      "stack",
      "roadmap",
      "deploy",
      "cloud",
      "local",
    ],
  },
  {
    intent: "research",
    keywords: ["research", "latest", "find", "compare", "source", "verify", "citation"],
  },
  {
    intent: "writing",
    keywords: ["write", "explain", "email", "summary", "paragraph", "sentence", "docs"],
  },
];

export function selectBestTemplate(messyText: string): TemplateMatch {
  const templates = listTemplates();
  if (templates.length === 0) {
    throw new Error("No prompt templates are available.");
  }

  const queryTokens = tokenize(messyText);
  const inferredIntent = inferIntent(queryTokens);
  const ranked = templates
    .map((template) => scoreTemplate(template, queryTokens, inferredIntent))
    .sort((a, b) => b.score - a.score);
  const best = ranked[0];
  if (!best) {
    throw new Error("No prompt template could be selected.");
  }

  recordTemplateEvent(best.template.id, "selected");
  recordCategoryEvent(templateUsageCategory(best.template), "selected");
  return best;
}

export function recordTemplateStat(templateId: string, event: TemplateStatsEvent): void {
  recordTemplateEvent(templateId, event);
}

export function recordTemplateCategoryStat(
  template: TemplateRecord | undefined,
  event: TemplateStatsEvent
): void {
  if (!template) return;
  recordCategoryEvent(templateUsageCategory(template), event);
}

function templateUsageCategory(template: TemplateRecord): string {
  return template.task_type === "review" ? "review" : template.intent_type;
}

function scoreTemplate(
  template: TemplateRecord,
  queryTokens: string[],
  inferredIntent: string
): TemplateMatch {
  const stats = getTemplateStats(template.id);
  const templateTokens = tokenize(
    [
      template.name,
      template.description,
      template.intent_type,
      template.domain,
      template.task_type,
      template.tags,
      template.output_style,
      template.instructions,
    ].join(" ")
  );
  const templateTokenSet = new Set(templateTokens);
  const matchedTokens = queryTokens.filter((token) => templateTokenSet.has(token));
  const keywordScore =
    queryTokens.length > 0 ? matchedTokens.length / Math.max(1, queryTokens.length) : 0;
  const intentScore = template.intent_type === inferredIntent ? 0.35 : 0;
  const qualityScore = (template.quality_score + stats.quality_score) / 2;
  const usageScore = Math.min(0.1, stats.executed_count * 0.01 + stats.accepted_count * 0.005);
  const frictionPenalty = Math.min(
    0.15,
    stats.rejected_count * 0.02 + stats.regenerated_count * 0.01 + stats.edited_count * 0.005
  );
  const score = keywordScore * 0.4 + intentScore + qualityScore * 0.2 + usageScore - frictionPenalty;

  const reasons = [
    template.intent_type === inferredIntent ? `intent:${inferredIntent}` : "",
    matchedTokens.length > 0 ? `matched:${matchedTokens.slice(0, 6).join(",")}` : "",
    `quality:${qualityScore.toFixed(2)}`,
    stats.executed_count > 0 ? `executed:${stats.executed_count}` : "",
  ].filter(Boolean);

  return {
    template,
    stats,
    score,
    reasons,
    inferred_intent_type: inferredIntent,
  };
}

function inferIntent(tokens: string[]): string {
  let bestIntent = "writing";
  let bestScore = -1;
  for (const rule of INTENT_RULES) {
    const hits = rule.keywords.filter((keyword) => tokens.includes(keyword)).length;
    if (hits > bestScore) {
      bestIntent = rule.intent;
      bestScore = hits;
    }
  }
  return bestScore > 0 ? bestIntent : "writing";
}

function tokenize(input: string): string[] {
  return Array.from(
    new Set(
      input
        .toLowerCase()
        .split(/[^a-z0-9]+/g)
        .filter((token) => token.length >= 3)
    )
  ).slice(0, 48);
}
