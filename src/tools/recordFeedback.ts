import { db } from "../memory/db.js";
import { getLevenshteinDistance } from "../utils/levenshtein.js";

export function recordFeedback(promptId: number, rating: number, userEdits?: string) {
  let distance = 0;

  if (userEdits) {
    // 1. Find the original refined prompt in the DB
    const original = db.prepare("SELECT refined_prompt FROM prompt_history WHERE id = ?").get(promptId) as {refined_prompt: string} |undefined;

    if (original?.refined_prompt) {
      // 2. Calculate how much the user changed it
      // A high distance means the AI was far off the mark.
      distance = getLevenshteinDistance(original.refined_prompt, userEdits);
    }
  }

  // 3. Save the feedback
  const stmt = db.prepare(`
    INSERT INTO feedback (prompt_id, rating, user_edits, edit_distance)
    VALUES (?, ?, ?, ?)
  `);
  
  stmt.run(promptId, rating, userEdits || null, distance);
}