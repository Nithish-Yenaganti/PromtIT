import { db } from "../memory/db.js";

export function recordFeedback(
  promptId: number,
  score: number,
  source: "LSP" | "Agent" | "User",
  metadata?: unknown
) {
  const stmt = db.prepare(`
    INSERT INTO feedback (prompt_id, score, source, metadata)
    VALUES (?, ?, ?, ?)
    ON CONFLICT DO UPDATE SET
      metadata = excluded.metadata,
      created_at = CURRENT_TIMESTAMP
  `);

  const metadataText =
    metadata === undefined ? null : JSON.stringify(metadata);
  stmt.run(promptId, score, source, metadataText);
}
