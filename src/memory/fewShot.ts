import { db } from "./db.js";
import { getEmbedding } from "./embeddings.js";

type PromptHistoryRow = {
  raw_prompt: string;
  refined_prompt: string;
  embedding: Uint8Array | null;
};

type SimilarExample = {
  raw_prompt: string;
  refined_prompt: string;
  similarity: number;
};

export async function getContextualExamples(currentPrompt: string, providedVector?: number[]) {
  const currentVector = providedVector ?? await getEmbedding(currentPrompt);
  
  // We pull the last 50 prompts to compare
  const history = db
    .prepare(
      "SELECT raw_prompt, refined_prompt, embedding FROM prompt_history ORDER BY created_at DESC LIMIT 50"
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
      return { ...row, similarity };
    })
    .filter((ex): ex is SimilarExample => ex != null)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3); // Get the top 3 most relevant examples

  return examples
    .map((ex) => `User: ${ex.raw_prompt}\nRefined: ${ex.refined_prompt}`)
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
