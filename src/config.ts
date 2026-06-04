import os from "os";
import path from "path";

export const MAX_TEXT_CHARS = 16000;

export const DATABASE_CANDIDATE_PATHS = [
  process.env.PROMPTIT_DB_PATH?.trim(),
  path.join(process.cwd(), "data", "promptit.db"),
  path.join(os.tmpdir(), "promptit", "promptit.db"),
  path.join(os.homedir(), ".promptit", "promptit.db"),
];
