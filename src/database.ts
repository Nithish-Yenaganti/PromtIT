import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import path from "path";
import { DATABASE_CANDIDATE_PATHS } from "./config";

export type TemplateStatsEvent =
  | "selected"
  | "accepted"
  | "edited"
  | "regenerated"
  | "rejected"
  | "executed";

export type TemplateRecord = {
  id: string;
  name: string;
  description: string;
  source: string;
  version: string;
  intent_type: string;
  domain: string;
  task_type: string;
  tags: string;
  seniority_level: string;
  output_style: string;
  instructions: string;
  expected_output: string;
  quality_score: number;
  created_at?: string;
  updated_at?: string;
};

export type TemplateStats = {
  template_id: string;
  selected_count: number;
  accepted_count: number;
  edited_count: number;
  regenerated_count: number;
  rejected_count: number;
  executed_count: number;
  last_used_at: string | null;
  quality_score: number;
};

export type CategoryStatsEvent =
  | "selected"
  | "accepted"
  | "edited"
  | "regenerated"
  | "rejected"
  | "executed"
  | "synced";

export type CategoryStats = {
  category: string;
  selected_count: number;
  accepted_count: number;
  edited_count: number;
  regenerated_count: number;
  rejected_count: number;
  executed_count: number;
  synced_count: number;
  last_used_at: string | null;
  last_synced_at: string | null;
};

function uniquePaths(paths: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    ordered.push(resolved);
  }
  return ordered;
}

function openWritableDatabase(dbPath: string): Database {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const candidate = new Database(dbPath, { create: true });
  try {
    candidate.run("CREATE TABLE IF NOT EXISTS __promptit_healthcheck (id INTEGER PRIMARY KEY, ts TEXT)");
    candidate.run("INSERT INTO __promptit_healthcheck (ts) VALUES (CURRENT_TIMESTAMP)");
    candidate.run("DELETE FROM __promptit_healthcheck");
    return candidate;
  } catch (error) {
    try {
      candidate.close();
    } catch {
      // close is best effort only
    }
    throw error;
  }
}

function selectDatabase(): { db: Database; dbPath: string } {
  const candidates = uniquePaths(DATABASE_CANDIDATE_PATHS);
  const errors: string[] = [];

  for (const dbPath of candidates) {
    try {
      const selected = openWritableDatabase(dbPath);
      process.stderr.write(`Using PromptIT DB: ${dbPath}\n`);
      return { db: selected, dbPath };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${dbPath}: ${message}`);
    }
  }

  throw new Error(
    `Unable to open a writable PromptIT database. Tried:\n${errors.join("\n")}`
  );
}

const selected = selectDatabase();
export const db = selected.db;

db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA busy_timeout = 5000;");
db.run("PRAGMA foreign_keys = ON;");

export function initDatabase(): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS template_cache (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      source TEXT NOT NULL,
      version TEXT NOT NULL,
      intent_type TEXT NOT NULL,
      domain TEXT NOT NULL,
      task_type TEXT NOT NULL,
      tags TEXT NOT NULL,
      seniority_level TEXT NOT NULL,
      output_style TEXT NOT NULL,
      instructions TEXT NOT NULL,
      expected_output TEXT NOT NULL,
      quality_score REAL NOT NULL DEFAULT 0.5 CHECK (quality_score >= 0 AND quality_score <= 1),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS template_stats (
      template_id TEXT PRIMARY KEY,
      selected_count INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      edited_count INTEGER NOT NULL DEFAULT 0,
      regenerated_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      executed_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      quality_score REAL NOT NULL DEFAULT 0.5 CHECK (quality_score >= 0 AND quality_score <= 1),
      FOREIGN KEY(template_id) REFERENCES template_cache(id) ON DELETE CASCADE
    ) STRICT;
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS category_stats (
      category TEXT PRIMARY KEY,
      selected_count INTEGER NOT NULL DEFAULT 0,
      accepted_count INTEGER NOT NULL DEFAULT 0,
      edited_count INTEGER NOT NULL DEFAULT 0,
      regenerated_count INTEGER NOT NULL DEFAULT 0,
      rejected_count INTEGER NOT NULL DEFAULT 0,
      executed_count INTEGER NOT NULL DEFAULT 0,
      synced_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      last_synced_at TEXT
    ) STRICT;
  `);

  seedDefaultTemplates();
}

export function upsertTemplates(templates: TemplateRecord[]): void {
  const stmt = db.prepare(`
    INSERT INTO template_cache (
      id, name, description, source, version, intent_type, domain, task_type,
      tags, seniority_level, output_style, instructions, expected_output, quality_score
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      source = excluded.source,
      version = excluded.version,
      intent_type = excluded.intent_type,
      domain = excluded.domain,
      task_type = excluded.task_type,
      tags = excluded.tags,
      seniority_level = excluded.seniority_level,
      output_style = excluded.output_style,
      instructions = excluded.instructions,
      expected_output = excluded.expected_output,
      quality_score = excluded.quality_score,
      updated_at = CURRENT_TIMESTAMP
  `);

  const ensureStats = db.prepare(`
    INSERT INTO template_stats (template_id, quality_score)
    VALUES (?, ?)
    ON CONFLICT(template_id) DO NOTHING
  `);

  const tx = db.transaction((rows: TemplateRecord[]) => {
    for (const row of rows) {
      stmt.run(
        row.id,
        row.name,
        row.description,
        row.source,
        row.version,
        row.intent_type,
        row.domain,
        row.task_type,
        row.tags,
        row.seniority_level,
        row.output_style,
        row.instructions,
        row.expected_output,
        row.quality_score
      );
      ensureStats.run(row.id, row.quality_score);
    }
  });

  tx(templates);
}

export function listTemplates(): TemplateRecord[] {
  return db
    .prepare(
      `SELECT id, name, description, source, version, intent_type, domain, task_type,
              tags, seniority_level, output_style, instructions, expected_output, quality_score,
              created_at, updated_at
       FROM template_cache
       ORDER BY quality_score DESC, updated_at DESC`
    )
    .all() as TemplateRecord[];
}

export function getTemplateStats(templateId: string): TemplateStats {
  const row = db
    .prepare(
      `SELECT template_id, selected_count, accepted_count, edited_count, regenerated_count,
              rejected_count, executed_count, last_used_at, quality_score
       FROM template_stats
       WHERE template_id = ?`
    )
    .get(templateId) as TemplateStats | undefined;

  if (row) return row;

  db.prepare(
    `INSERT INTO template_stats (template_id, quality_score)
     VALUES (?, 0.5)
     ON CONFLICT(template_id) DO NOTHING`
  ).run(templateId);

  return {
    template_id: templateId,
    selected_count: 0,
    accepted_count: 0,
    edited_count: 0,
    regenerated_count: 0,
    rejected_count: 0,
    executed_count: 0,
    last_used_at: null,
    quality_score: 0.5,
  };
}

export function recordTemplateEvent(templateId: string, event: TemplateStatsEvent): void {
  const columnByEvent: Record<TemplateStatsEvent, string> = {
    selected: "selected_count",
    accepted: "accepted_count",
    edited: "edited_count",
    regenerated: "regenerated_count",
    rejected: "rejected_count",
    executed: "executed_count",
  };
  const column = columnByEvent[event];

  db.prepare(
    `INSERT INTO template_stats (template_id, ${column}, last_used_at, quality_score)
     VALUES (?, 1, CURRENT_TIMESTAMP, 0.5)
     ON CONFLICT(template_id) DO UPDATE SET
       ${column} = ${column} + 1,
       last_used_at = CURRENT_TIMESTAMP,
       quality_score = min(1.0, max(0.0,
         quality_score
         + CASE
             WHEN ? IN ('accepted', 'executed') THEN 0.03
             WHEN ? IN ('edited', 'regenerated') THEN -0.01
             WHEN ? = 'rejected' THEN -0.04
             ELSE 0
           END
       ))`
  ).run(templateId, event, event, event);
}

export function recordCategoryEvent(category: string, event: CategoryStatsEvent): void {
  const normalized = normalizeCategoryName(category);
  if (!normalized) return;

  const columnByEvent: Record<CategoryStatsEvent, string> = {
    selected: "selected_count",
    accepted: "accepted_count",
    edited: "edited_count",
    regenerated: "regenerated_count",
    rejected: "rejected_count",
    executed: "executed_count",
    synced: "synced_count",
  };
  const column = columnByEvent[event];
  const usedAt = event === "synced" ? "last_used_at" : "CURRENT_TIMESTAMP";
  const syncedAt = event === "synced" ? "CURRENT_TIMESTAMP" : "last_synced_at";

  db.prepare(
    `INSERT INTO category_stats (category, ${column}, last_used_at, last_synced_at)
     VALUES (?, 1, ${event === "synced" ? "NULL" : "CURRENT_TIMESTAMP"}, ${event === "synced" ? "CURRENT_TIMESTAMP" : "NULL"})
     ON CONFLICT(category) DO UPDATE SET
       ${column} = ${column} + 1,
       last_used_at = ${usedAt},
       last_synced_at = ${syncedAt}`
  ).run(normalized);
}

export function getCategoryStats(category: string): CategoryStats {
  const normalized = normalizeCategoryName(category);
  const row = db
    .prepare(
      `SELECT category, selected_count, accepted_count, edited_count, regenerated_count,
              rejected_count, executed_count, synced_count, last_used_at, last_synced_at
       FROM category_stats
       WHERE category = ?`
    )
    .get(normalized) as CategoryStats | undefined;

  if (row) return row;

  return {
    category: normalized,
    selected_count: 0,
    accepted_count: 0,
    edited_count: 0,
    regenerated_count: 0,
    rejected_count: 0,
    executed_count: 0,
    synced_count: 0,
    last_used_at: null,
    last_synced_at: null,
  };
}

export function listCategoryStats(): CategoryStats[] {
  return db
    .prepare(
      `SELECT category, selected_count, accepted_count, edited_count, regenerated_count,
              rejected_count, executed_count, synced_count, last_used_at, last_synced_at
       FROM category_stats
       ORDER BY executed_count DESC, accepted_count DESC, selected_count DESC`
    )
    .all() as CategoryStats[];
}

function normalizeCategoryName(category: string): string {
  return category.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

function seedDefaultTemplates(): void {
  const existing = db.prepare("SELECT COUNT(*) AS count FROM template_cache").get() as
    | { count: number }
    | undefined;
  if ((existing?.count ?? 0) > 0) return;
  upsertTemplates(DEFAULT_TEMPLATES);
}

const DEFAULT_TEMPLATES: TemplateRecord[] = [
  {
    id: "prompts-chat.coding-change.v1",
    name: "Coding Change Request",
    description: "Turns a messy implementation request into scoped engineering instructions.",
    source: "prompts.chat",
    version: "1",
    intent_type: "coding",
    domain: "software",
    task_type: "implementation",
    tags: "code,build,fix,implement,repo,branch,typescript,javascript,bun,node",
    seniority_level: "intermediate",
    output_style: "concise implementation prompt",
    instructions:
      "Convert the user request into clear coding instructions. Preserve repo constraints, expected files, validation commands, and delivery requirements. Avoid adding unrelated scope.",
    expected_output:
      "A compact execution-ready coding prompt with objective, constraints, validation, and expected result.",
    quality_score: 0.75,
  },
  {
    id: "prompts-chat.code-review.v1",
    name: "Code Review",
    description: "Turns a review request into a findings-first code review prompt.",
    source: "prompts.chat",
    version: "1",
    intent_type: "coding",
    domain: "software",
    task_type: "review",
    tags: "review,bug,risk,regression,test,security,performance",
    seniority_level: "advanced",
    output_style: "findings first",
    instructions:
      "Ask the host agent to review for correctness, regressions, security, missing tests, and maintainability. Findings must be grounded in file and line references when available.",
    expected_output:
      "Ordered findings, open questions, and a short summary only after issues.",
    quality_score: 0.72,
  },
  {
    id: "prompts-chat.architecture.v1",
    name: "Architecture Decision",
    description: "Turns a vague product/system direction into a pragmatic architecture prompt.",
    source: "prompts.chat",
    version: "1",
    intent_type: "planning",
    domain: "architecture",
    task_type: "architecture",
    tags: "architecture,system,stack,database,mcp,deploy,cloud,local,scale",
    seniority_level: "intermediate",
    output_style: "architecture decision record",
    instructions:
      "Frame the request as an architecture decision. Prefer boring reversible choices, state system boundaries, data model direction, operational cost, risks, and rejected alternatives.",
    expected_output:
      "A practical architecture recommendation with tradeoffs and next steps.",
    quality_score: 0.78,
  },
  {
    id: "prompts-chat.writing.v1",
    name: "Clear Writing",
    description: "Turns messy writing intent into a concise drafting or editing prompt.",
    source: "prompts.chat",
    version: "1",
    intent_type: "writing",
    domain: "communication",
    task_type: "drafting",
    tags: "write,explain,email,summary,docs,copy,paragraph,sentence",
    seniority_level: "beginner",
    output_style: "plain language",
    instructions:
      "Clarify the audience, desired tone, and output length. Ask the host agent to produce direct, readable writing without filler.",
    expected_output:
      "A clean writing prompt with audience, tone, format, and length constraints.",
    quality_score: 0.7,
  },
  {
    id: "prompts-chat.research.v1",
    name: "Research Task",
    description: "Turns a messy research request into a source-aware research prompt.",
    source: "prompts.chat",
    version: "1",
    intent_type: "research",
    domain: "general",
    task_type: "research",
    tags: "research,compare,latest,source,citation,verify,find",
    seniority_level: "intermediate",
    output_style: "sourced answer",
    instructions:
      "Clarify the question, required freshness, acceptable sources, and output format. Require source attribution when facts may have changed.",
    expected_output:
      "A research prompt with scope, source requirements, and answer format.",
    quality_score: 0.68,
  },
];
