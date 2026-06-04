import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import path from "path";
import { DATABASE_CANDIDATE_PATHS } from "./config";

export type PreflightDecision = "skip" | "allow" | "warn" | "needs_confirmation" | "block";

export type PreflightStats = {
  risk_type: string;
  decision: PreflightDecision;
  outcome: string;
  count: number;
  last_used_at: string;
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

  throw new Error(`Unable to open a writable PromptIT database. Tried:\n${errors.join("\n")}`);
}

const selected = selectDatabase();
export const db = selected.db;

db.run("PRAGMA journal_mode = WAL;");
db.run("PRAGMA busy_timeout = 5000;");
db.run("PRAGMA foreign_keys = ON;");

export function initDatabase(): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS preflight_stats (
      risk_type TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('skip', 'allow', 'warn', 'needs_confirmation', 'block')),
      outcome TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (risk_type, decision, outcome)
    ) STRICT;
  `);
}

export function recordPreflightEvent(
  riskType: string,
  decision: PreflightDecision,
  outcome: string
): void {
  const normalizedRisk = normalizeKey(riskType);
  const normalizedOutcome = normalizeKey(outcome);
  if (!normalizedRisk || !normalizedOutcome) return;
  db.prepare(
    `INSERT INTO preflight_stats (risk_type, decision, outcome, count, last_used_at)
     VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP)
     ON CONFLICT(risk_type, decision, outcome) DO UPDATE SET
       count = count + 1,
       last_used_at = CURRENT_TIMESTAMP`
  ).run(normalizedRisk, decision, normalizedOutcome);
}

export function listPreflightStats(): PreflightStats[] {
  return db
    .prepare(
      `SELECT risk_type, decision, outcome, count, last_used_at
       FROM preflight_stats
       ORDER BY count DESC, last_used_at DESC`
    )
    .all() as PreflightStats[];
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}
