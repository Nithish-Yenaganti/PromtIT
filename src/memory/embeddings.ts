import { pipeline } from "@xenova/transformers";

let extractor: any = null;
let extractorInitPromise: Promise<any> | null = null;
const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

async function ensureExtractor(): Promise<any> {
  if (extractor) return extractor;

  if (!extractorInitPromise) {
    extractorInitPromise = (async () => {
      process.stderr.write("Loading embedding model...\n");
      const loaded = await pipeline("feature-extraction", EMBEDDING_MODEL);
      process.stderr.write("Embedding model ready.\n");
      extractor = loaded;
      return loaded;
    })().catch((error) => {
      // Allow retry on the next call if initialization fails.
      extractorInitPromise = null;
      throw error;
    });
  }

  return extractorInitPromise;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const model = await ensureExtractor();

  // Generate the embedding
  const output = await model(text, {
    pooling: "mean",
    normalize: true,
  });

  // Transformers.js returns a Tensor object; we convert it to a standard JS Array
  return Array.from(output.data);
}

export function startEmbeddingWarmup(): void {
  void ensureExtractor().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Embedding warmup failed: ${message}\n`);
  });
}
