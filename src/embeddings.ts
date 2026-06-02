import { pipeline } from "@xenova/transformers";
import { EMBEDDING_MODEL, LOCAL_ONLY_MODELS } from "./config";

// Runtime defaults for stable local inference on Bun/CPU environments.
if (!process.env.TRANSFORMERS_BACKEND) {
  process.env.TRANSFORMERS_BACKEND = "wasm";
}
if (!process.env.OMP_NUM_THREADS) {
  process.env.OMP_NUM_THREADS = "1";
}
if (!process.env.ORT_NUM_THREADS) {
  process.env.ORT_NUM_THREADS = "1";
}

let extractor: any = null;
let extractorInitPromise: Promise<any> | null = null;

async function ensureExtractor(): Promise<any> {
  if (extractor) return extractor;

  if (!extractorInitPromise) {
    extractorInitPromise = (async () => {
      process.stderr.write("Loading embedding model...\n");
      const loaded = await pipeline("feature-extraction", EMBEDDING_MODEL, {
        local_files_only: LOCAL_ONLY_MODELS,
      });
      process.stderr.write("Embedding model ready.\n");
      extractor = loaded;
      return loaded;
    })().catch((error) => {
      extractorInitPromise = null;
      throw error;
    });
  }

  return extractorInitPromise;
}

export async function getEmbedding(text: string): Promise<number[]> {
  const model = await ensureExtractor();
  const output = await model(text, {
    pooling: "mean",
    normalize: true,
  });
  return Array.from(output.data);
}

export function startEmbeddingWarmup(): void {
  void ensureExtractor().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Embedding warmup failed: ${message}\n`);
  });
}
