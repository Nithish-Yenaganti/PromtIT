import { pipeline } from "@xenova/transformers";

type LocalRefineResult =
  | { ok: true; refinedPrompt: string; notice?: string }
  | { ok: false; message: string };

const LOCAL_REFINER_MODEL =
  process.env.PROMPTIT_LOCAL_REFINER_MODEL?.trim() ||
  "onnx-community/Llama-3.2-1B-Instruct-ONNX";
const LOCAL_ONLY_MODELS = process.env.PROMPTIT_LOCAL_MODELS_ONLY === "1";
const MAX_NEW_TOKENS = Number(
  process.env.PROMPTIT_LOCAL_REFINER_MAX_TOKENS?.trim() || "900"
);

let generator: any = null;
let generatorInitPromise: Promise<any> | null = null;
let didShowDownloadNotice = false;

async function ensureGenerator(): Promise<any> {
  if (generator) return generator;

  if (!generatorInitPromise) {
    if (!LOCAL_ONLY_MODELS && !didShowDownloadNotice) {
      process.stderr.write(
        "Local fallback model may download on first run. This can take time.\n"
      );
      didShowDownloadNotice = true;
    }

    generatorInitPromise = (async () => {
      process.stderr.write(`Loading local refiner model (${LOCAL_REFINER_MODEL})...\n`);
      const loaded = await pipeline("text-generation", LOCAL_REFINER_MODEL, {
        local_files_only: LOCAL_ONLY_MODELS,
      });
      process.stderr.write("Local refiner model ready.\n");
      generator = loaded;
      return loaded;
    })().catch((error) => {
      generatorInitPromise = null;
      throw error;
    });
  }

  return generatorInitPromise;
}

function extractGeneratedText(output: unknown, sourcePrompt: string): string {
  if (!Array.isArray(output) || output.length === 0) {
    throw new Error("local refiner returned empty output");
  }

  const first = output[0] as { generated_text?: unknown } | undefined;
  if (typeof first?.generated_text !== "string") {
    throw new Error("local refiner returned unsupported output format");
  }

  const raw = first.generated_text.trim();
  if (!raw) throw new Error("local refiner returned blank text");

  if (raw.startsWith(sourcePrompt)) {
    const trimmed = raw.slice(sourcePrompt.length).trim();
    if (trimmed) return trimmed;
  }

  return raw;
}

export async function refineWithLocalModel(prompt: string): Promise<LocalRefineResult> {
  try {
    const model = await ensureGenerator();
    const output = await model(prompt, {
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: false,
      temperature: 0.2,
      return_full_text: false,
    });

    const refinedPrompt = extractGeneratedText(output, prompt);
    return {
      ok: true,
      refinedPrompt,
      notice:
        "Sampling was unavailable, so PromptIT used local Llama fallback. If not cached, first run may download model files.",
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `local fallback failed: ${message}` };
  }
}

export function startLocalRefinerWarmup(): void {
  // Keep local model lazy to avoid forced downloads at startup.
}
