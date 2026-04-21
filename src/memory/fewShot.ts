import { db } from "./db.js";
import { getEmbedding } from "./embeddings.js";

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

export async function getContextualExamples(currentPrompt: string, providedVector?: number[]) {
  const currentVector = providedVector ?? await getEmbedding(currentPrompt);
  
  const similarityWeight = 0.8;
  const feedbackWeight = 0.2;

  // We pull the last 50 prompts to compare
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

  // Calculate similarity and sort
  const examples = history
    .map((row): SimilarExample | null => {
      if (!row || !row.embedding) return null;

      const bytes = row.embedding as Uint8Array; // Buffer is a Uint8Array in Bun/Node
      if (bytes.byteLength % 4 !== 0) return null; // invalid float32 payload

      const rowVector = new Float32Array(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength / 4
      );

      if (rowVector.length !== currentVector.length) return null;
      const similarity = dotProduct(currentVector, rowVector);
      const blended_rank = similarity * similarityWeight + row.avg_score * feedbackWeight;
      return { ...row, similarity, blended_rank };
    })
    .filter((ex): ex is SimilarExample => ex != null)
    .sort((a, b) => b.blended_rank - a.blended_rank)
    .slice(0, 3); // Get the top 3 most relevant examples

  return examples
    .map(
      (ex) =>
        `User: ${ex.raw_prompt}\nRefined: ${ex.refined_prompt}\nFeedbackScore: ${ex.avg_score.toFixed(2)}`
    )
    .join("\n\n");
}

function dotProduct(a: number[], b: ArrayLike<number>) {
  if (a.length !== b.length) {
    throw new Error(`Vector size mismatch: ${a.length} vs ${b.length}`);
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}
