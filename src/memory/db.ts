import { Database } from "bun:sqlite";
import path from "path";
import { mkdirSync } from "fs";
import os from "os";

const defaultDbDir = path.join(os.homedir(), ".promptit");
const configuredPath = process.env.PROMPTIT_DB_PATH?.trim();
const DB_PATH = configuredPath || path.join(defaultDbDir, "memory.db");
mkdirSync(path.dirname(DB_PATH), { recursive: true });
export const db = new Database(DB_PATH, { create: true });

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
      rating INTEGER CHECK (rating BETWEEN -1 AND 1),
      user_edits TEXT,
      edit_distance INTEGER,
      FOREIGN KEY(prompt_id) REFERENCES prompt_history(id)
    ) STRICT;
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS refinement_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_prompt TEXT NOT NULL,
      candidate_prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'needs_review' CHECK (status IN ('needs_review', 'accepted', 'rejected')),
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_retry_note TEXT,
      last_edit_note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
  `);

  ensureFeedbackSchema();
  ensureRefinementQueueSchema();
}

function ensureFeedbackSchema() {
  const columns = db.prepare("PRAGMA table_info(feedback)").all() as Array<{ name?: string }>;
  const hasEditDistance = columns.some((col) => col.name === "edit_distance");

  // Existing DBs created before edit_distance was introduced need a one-time migration.
  if (!hasEditDistance) {
    db.run("ALTER TABLE feedback ADD COLUMN edit_distance INTEGER");
  }
}

function ensureRefinementQueueSchema() {
  const columns = db.prepare("PRAGMA table_info(refinement_queue)").all() as Array<{ name?: string }>;
  const existing = new Set(columns.map((col) => col.name).filter((name): name is string => Boolean(name)));
  const requiredColumns: Array<{ name: string; def: string }> = [
    { name: "retry_count", def: "INTEGER NOT NULL DEFAULT 0" },
    { name: "last_retry_note", def: "TEXT" },
    { name: "last_edit_note", def: "TEXT" },
    { name: "updated_at", def: "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP" },
  ];

  for (const col of requiredColumns) {
    if (!existing.has(col.name)) {
      db.run(`ALTER TABLE refinement_queue ADD COLUMN ${col.name} ${col.def}`);
    }
  }
}

/**
 * Helper to save a prompt with its embedding
 */
export function savePrompt(raw: string, refined: string, embedding: number[]):number {
  const stmt = db.prepare(`
    INSERT INTO prompt_history (raw_prompt, refined_prompt, embedding)
    VALUES (?, ?, ?)
  `);
  
  // Convert the array of numbers to a Buffer for storage
  const buffer = Buffer.from(new Float32Array(embedding).buffer);
  const result = stmt.run(raw, refined, buffer);

  return result.lastInsertRowid as number;
}

export type RefinementSession = {
  id: number;
  raw_prompt: string;
  candidate_prompt: string;
  status: "needs_review" | "accepted" | "rejected";
  retry_count: number;
  last_retry_note?: string | null;
  last_edit_note?: string | null;
};

export function createRefinementSession(rawPrompt: string, candidatePrompt: string): number {
  const stmt = db.prepare(`
    INSERT INTO refinement_queue (raw_prompt, candidate_prompt, status)
    VALUES (?, ?, 'needs_review')
  `);
  const result = stmt.run(rawPrompt, candidatePrompt);
  return result.lastInsertRowid as number;
}

export function getRefinementSession(id: number): RefinementSession | null {
  const row = db
    .prepare(
      `SELECT id, raw_prompt, candidate_prompt, status, retry_count, last_retry_note, last_edit_note FROM refinement_queue WHERE id = ?`
    )
    .get(id) as RefinementSession | undefined;
  return row ?? null;
}

export function updateRefinementSession(
  id: number,
  candidatePrompt: string,
  retryNote?: string
): void {
  const stmt = db.prepare(`
    UPDATE refinement_queue
    SET
      candidate_prompt = ?,
      status = 'needs_review',
      retry_count = retry_count + 1,
      last_retry_note = ?,
      last_edit_note = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  stmt.run(candidatePrompt, retryNote ?? null, id);
}

export function editRefinementSession(
  id: number,
  candidatePrompt: string,
  editNote: string
): void {
  const stmt = db.prepare(`
    UPDATE refinement_queue
    SET
      candidate_prompt = ?,
      status = 'needs_review',
      last_edit_note = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  stmt.run(candidatePrompt, editNote, id);
}

export function markRefinementAccepted(id: number): void {
  const stmt = db.prepare(`
    UPDATE refinement_queue
    SET status = 'accepted', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  stmt.run(id);
}

export function getLatestHistoryPromptId(): number | null {
  const row = db
    .prepare("SELECT id FROM prompt_history ORDER BY id DESC LIMIT 1")
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}
