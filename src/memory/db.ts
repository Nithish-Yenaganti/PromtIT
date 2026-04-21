import { Database } from "bun:sqlite";
import path from "path";
import { mkdirSync } from "fs";
import os from "os";

const configuredPath = process.env.PROMPTIT_DB_PATH?.trim();
const projectPath = path.join(process.cwd(), "data", "memory.db");
const tempPath = path.join(os.tmpdir(), "promptit", "memory.db");
const homePath = path.join(os.homedir(), ".promptit", "memory.db");

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
    // Validate writability early so startup never proceeds with a readonly DB.
    candidate.run("CREATE TABLE IF NOT EXISTS __promptit_healthcheck (id INTEGER PRIMARY KEY, ts TEXT)");
    candidate.run("INSERT INTO __promptit_healthcheck (ts) VALUES (CURRENT_TIMESTAMP)");
    candidate.run("DELETE FROM __promptit_healthcheck");
    return candidate;
  } catch (error) {
    try {
      candidate.close();
    } catch {
      // no-op: close best effort
    }
    throw error;
  }
}

function selectDatabase(): { db: Database; dbPath: string } {
  const candidates = uniquePaths([configuredPath, projectPath, tempPath, homePath]);
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

// Setup high-performance mode
db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA busy_timeout = 5000;"); //wait up to 5s i DB is busy
db.run("PRAGMA foreign_keys = ON;");


export function initDB() {
  // table for prompts and their "meaning" (embeddings)
  db.run(`
    CREATE TABLE IF NOT EXISTS prompt_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_prompt TEXT NOT NULL,
      refined_prompt TEXT NOT NULL,
      embedding BLOB,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
  `);

  // table for learning from the user
  db.run(`
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_id INTEGER NOT NULL,
      score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
      source TEXT NOT NULL CHECK (source IN ('LSP', 'Agent', 'User')),
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(prompt_id) REFERENCES prompt_history(id)
    ) STRICT;
  `);

  ensureExpertLibrarySchema();
  ensureUserMemorySchema();
  ensureFeedbackSchema();
  ensureDedupeIndexes();
}

function ensureExpertLibrarySchema() {
  const createWithVectorType = `
    CREATE TABLE IF NOT EXISTS expert_library (
      slug TEXT PRIMARY KEY,
      role TEXT,
      content TEXT,
      category TEXT,
      embedding F32_BLOB
    );
  `;

  const createWithBlob = `
    CREATE TABLE IF NOT EXISTS expert_library (
      slug TEXT PRIMARY KEY,
      role TEXT,
      content TEXT,
      category TEXT,
      embedding BLOB
    ) STRICT;
  `;

  try {
    db.run(createWithVectorType);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `expert_library: F32_BLOB unavailable (${message}). Falling back to BLOB.\n`
    );
    db.run(createWithBlob);
  }
}

function ensureFeedbackSchema() {
  const columns = db.prepare("PRAGMA table_info(feedback)").all() as Array<{ name?: string }>;
  const existing = new Set(
    columns.map((col) => col.name).filter((name): name is string => Boolean(name))
  );
  const requiredColumns: Array<{ name: string; def: string }> = [
    { name: "score", def: "REAL NOT NULL DEFAULT 0.5 CHECK (score >= 0 AND score <= 1)" },
    { name: "source", def: "TEXT NOT NULL DEFAULT 'Agent' CHECK (source IN ('LSP', 'Agent', 'User'))" },
    { name: "metadata", def: "TEXT" },
    { name: "created_at", def: "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP" },
  ];

  for (const col of requiredColumns) {
    if (!existing.has(col.name)) {
      db.run(`ALTER TABLE feedback ADD COLUMN ${col.name} ${col.def}`);
    }
  }
}

function ensureUserMemorySchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS user_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_key TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      tags TEXT,
      embedding BLOB,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
  `);
}

function ensureDedupeIndexes() {
  // Keep only the latest duplicate prompt pair before adding unique index.
  db.run(`
    DELETE FROM prompt_history
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM prompt_history
      GROUP BY raw_prompt, refined_prompt
    );
  `);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_history_dedupe
    ON prompt_history(raw_prompt, refined_prompt);
  `);

  // Keep only the latest duplicate feedback tuple before adding dedupe index.
  db.run(`
    DELETE FROM feedback
    WHERE id NOT IN (
      SELECT MAX(id)
      FROM feedback
      GROUP BY prompt_id, score, source, ifnull(metadata, '')
    );
  `);
  db.run(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_dedupe
    ON feedback(prompt_id, score, source, ifnull(metadata, ''));
  `);
}

/**
 * Helper to save a prompt with its embedding
 */
export function savePrompt(raw: string, refined: string, embedding?: number[] | null): number {
  const stmt = db.prepare(`
    INSERT INTO prompt_history (raw_prompt, refined_prompt, embedding)
    VALUES (?, ?, ?)
    ON CONFLICT(raw_prompt, refined_prompt) DO UPDATE SET
      embedding = excluded.embedding,
      created_at = CURRENT_TIMESTAMP
    RETURNING id
  `);
  
  const buffer =
    Array.isArray(embedding) && embedding.length > 0
      ? Buffer.from(new Float32Array(embedding).buffer)
      : null;
  const row = stmt.get(raw, refined, buffer) as { id: number } | undefined;
  if (!row?.id) {
    throw new Error("Failed to upsert prompt_history row.");
  }
  return row.id;
}

export function getRecentRefinements(limit = 3): Array<{ raw_prompt: string; refined_prompt: string }> {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  return db
    .prepare(
      "SELECT raw_prompt, refined_prompt FROM prompt_history ORDER BY created_at DESC LIMIT ?"
    )
    .all(safeLimit) as Array<{ raw_prompt: string; refined_prompt: string }>;
}

type UpsertExpertArgs = {
  slug: string;
  role: string;
  content: string;
  category: string;
  embedding?: number[] | null;
};

export function upsertExpert(args: UpsertExpertArgs): void {
  const { slug, role, content, category, embedding } = args;
  const stmt = db.prepare(`
    INSERT INTO expert_library (slug, role, content, category, embedding)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      role = excluded.role,
      content = excluded.content,
      category = excluded.category,
      embedding = excluded.embedding
  `);

  const buffer =
    Array.isArray(embedding) && embedding.length > 0
      ? Buffer.from(new Float32Array(embedding).buffer)
      : null;

  stmt.run(slug, role, content, category, buffer);
}
