import os from "os";
import path from "path";

export const MAX_TEXT_CHARS = 16000;
export const MAX_METADATA_CHARS = 8000;
export const DEFAULT_CHARS_PER_TOKEN = 4;
export const EXECUTION_TOKEN_TTL_MS = 30 * 60 * 1000;

export const EMBEDDING_MODEL =
  process.env.PROMPTIT_EMBEDDING_MODEL?.trim() || "Xenova/all-MiniLM-L6-v2";
export const LOCAL_ONLY_MODELS = process.env.PROMPTIT_LOCAL_MODELS_ONLY === "1";

export const DATABASE_CANDIDATE_PATHS = [
  process.env.PROMPTIT_DB_PATH?.trim(),
  path.join(process.cwd(), "data", "memory.db"),
  path.join(os.tmpdir(), "promptit", "memory.db"),
  path.join(os.homedir(), ".promptit", "memory.db"),
];

export function parsePositiveNumberEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}
