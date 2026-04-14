import { db } from "./db.js";
import { getEmbedding } from "./embeddings.js";

export async function getContextualExamples(currentPrompt: string) {
  const currentVector = await getEmbedding(currentPrompt);
  
  // We pull the last 50 prompts to compare
  const history = db.prepare("SELECT raw_prompt, refined_prompt, embedding FROM prompt_history ORDER BY created_at DESC LIMIT 50").all() as any[];

  // Calculate similarity and sort
  const examples = history
    .map(row => {
        
      if (!row || !row.embedding) return null;
      const rowVector = new Float32Array(row.embedding.buffer);
      if (rowVector.length !== currentVector.length) return null;
      const similarity = dotProduct(currentVector, rowVector);
      return { ...row, similarity };
    })
    .filter((ex):ex is any => ex != null)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 3); // Get the top 3 most relevant examples

  return examples.map(ex => `User: ${ex.raw_prompt}\nRefined: ${ex.refined_prompt}`).join("\n\n");
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
