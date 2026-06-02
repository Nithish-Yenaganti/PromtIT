import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import path from "path";
import { DATABASE_CANDIDATE_PATHS } from "./config";

type PromptHistoryRow = {
  id: number;
  raw_prompt: string;
  refined_prompt: string;
  embedding: Uint8Array | null;
  avg_score: number;
};

type SimilarExample = {
  id: number;
  raw_prompt: string;
  refined_prompt: string;
  avg_score: number;
  similarity: number;
  blended_rank: number;
};

export type PromptPair = {
  raw_prompt: string;
  refined_prompt: string;
};

export type FeedbackSource = "LSP" | "Agent" | "User";

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
    CREATE TABLE IF NOT EXISTS prompt_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      raw_prompt TEXT NOT NULL,
      refined_prompt TEXT NOT NULL,
      embedding BLOB,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) STRICT;
  `);

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

function ensureExpertLibrarySchema(): void {
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

function ensureFeedbackSchema(): void {
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

function ensureUserMemorySchema(): void {
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

function ensureDedupeIndexes(): void {
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

export function recordFeedback(
  promptId: number,
  score: number,
  source: FeedbackSource,
  metadata?: unknown
): void {
  const stmt = db.prepare(`
    INSERT INTO feedback (prompt_id, score, source, metadata)
    VALUES (?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      metadata = excluded.metadata,
      created_at = CURRENT_TIMESTAMP
  `);

  const metadataText = metadata === undefined ? null : JSON.stringify(metadata);
  stmt.run(promptId, score, source, metadataText);
}

export function getRecentRefinements(limit = 3): PromptPair[] {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  return db
    .prepare(
      "SELECT raw_prompt, refined_prompt FROM prompt_history ORDER BY created_at DESC LIMIT ?"
    )
    .all(safeLimit) as PromptPair[];
}

export function getContextualExamples(currentVector: number[]): string {
  const similarityWeight = 0.8;
  const feedbackWeight = 0.2;

  const history = db
    .prepare(
      `SELECT
         p.id,
         p.raw_prompt,
         p.refined_prompt,
         p.embedding,
         COALESCE(AVG(f.score), 0.5) AS avg_score
       FROM prompt_history p
       LEFT JOIN feedback f ON f.prompt_id = p.id
       GROUP BY p.id, p.raw_prompt, p.refined_prompt, p.embedding, p.created_at
       ORDER BY p.created_at DESC
       LIMIT 50`
    )
    .all() as PromptHistoryRow[];

  const examples = history
    .map((row): SimilarExample | null => {
      if (!row?.embedding) return null;
      const rowVector = decodeFloat32Vector(row.embedding);
      if (!rowVector || rowVector.length !== currentVector.length) return null;
      const similarity = dotProduct(currentVector, rowVector);
      const blended_rank = similarity * similarityWeight + row.avg_score * feedbackWeight;
      return { ...row, similarity, blended_rank };
    })
    .filter((ex): ex is SimilarExample => ex != null)
    .sort((a, b) => b.blended_rank - a.blended_rank)
    .slice(0, 3);

  return examples
    .map(
      (ex) =>
        `User: ${ex.raw_prompt}\nRefined: ${ex.refined_prompt}\nFeedbackScore: ${ex.avg_score.toFixed(2)}`
    )
    .join("\n\n");
}

function decodeFloat32Vector(bytes: Uint8Array | null): Float32Array | null {
  if (!bytes || bytes.byteLength % 4 !== 0) return null;
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

function dotProduct(a: number[], b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}
