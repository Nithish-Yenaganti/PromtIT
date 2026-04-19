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
export const DB_PATH = selected.dbPath;
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

  ensureFeedbackSchema();
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

/**
 * Helper to save a prompt with its embedding
 */
export function savePrompt(raw: string, refined: string, embedding?: number[] | null): number {
  const stmt = db.prepare(`
    INSERT INTO prompt_history (raw_prompt, refined_prompt, embedding)
    VALUES (?, ?, ?)
  `);
  
  const buffer =
    Array.isArray(embedding) && embedding.length > 0
      ? Buffer.from(new Float32Array(embedding).buffer)
      : null;
  const result = stmt.run(raw, refined, buffer);

  return result.lastInsertRowid as number;
}

export function getRecentRefinements(limit = 3): Array<{ raw_prompt: string; refined_prompt: string }> {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  return db
    .prepare(
      "SELECT raw_prompt, refined_prompt FROM prompt_history ORDER BY created_at DESC LIMIT ?"
    )
    .all(safeLimit) as Array<{ raw_prompt: string; refined_prompt: string }>;
}
