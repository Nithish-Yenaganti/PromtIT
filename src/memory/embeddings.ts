import { pipeline } from "@xenova/transformers";

let extractor: any = null;

export async function getEmbedding(text: string): Promise<number[]> {
  if (!extractor) {
    // We use 'all-MiniLM-L6-v2' because it's tiny (30MB), 
    // fast, and highly accurate for English text.

    process.stderr.write("Let me check if the model is already loaded...\n");
    try{
        extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
        process.stderr.write("I see that model is loaded already!");
    }catch(error){
        process.stderr.write("Note: First-run download in progress (approx. 30MB). Please wait...\n");
        extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
        process.stderr.write("Download complete. Models initialized.\n");
    }
 
    
  }

  // Generate the embedding
  const output = await extractor(text, {
    pooling: "mean",
    normalize: true,
  });

  // Transformers.js returns a Tensor object; we convert it to a standard JS Array
  return Array.from(output.data);
}