import { Database } from "bun:sqlite";
import path from "path";

const DB_PATH = path.join(import.meta.dir, "../../data/memory.db");
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

  ensureFeedbackSchema();
}

function ensureFeedbackSchema() {
  const columns = db.prepare("PRAGMA table_info(feedback)").all() as Array<{ name?: string }>;
  const hasEditDistance = columns.some((col) => col.name === "edit_distance");

  // Existing DBs created before edit_distance was introduced need a one-time migration.
  if (!hasEditDistance) {
    db.run("ALTER TABLE feedback ADD COLUMN edit_distance INTEGER");
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
