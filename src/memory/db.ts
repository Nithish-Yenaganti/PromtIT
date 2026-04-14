import { Database } from "bun:sqlite";
import path from "path";

const DB_PATH = path.join(import.meta.dir, "../../data/memory.db");
export const db = new Database(DB_PATH, { create: true });

// Setup high-performance mode
db.run("PRAGMA journal_mode = WAL;");

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
      prompt_id INTEGER,
      rating INTEGER CHECK (rating BETWEEN -1 AND 1),
      user_edits TEXT,
      FOREIGN KEY(prompt_id) REFERENCES prompt_history(id)
    ) STRICT;
  `);
}

/**
 * Helper to save a prompt with its embedding
 */
export function savePrompt(raw: string, refined: string, embedding: number[]) {
  const stmt = db.prepare(`
    INSERT INTO prompt_history (raw_prompt, refined_prompt, embedding)
    VALUES (?, ?, ?)
  `);
  
  // Convert the array of numbers to a Buffer for storage
  const buffer = Buffer.from(new Float32Array(embedding).buffer);
  stmt.run(raw, refined, buffer);
}