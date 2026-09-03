import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { logger } from "../logger.ts";

env.cacheDir = "./data/model-cache";

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractorPromise) return extractorPromise;
  logger.info("Loading mxbai-embed-large-v1 model (first run downloads ~670MB)...");
  extractorPromise = pipeline("feature-extraction", "mixedbread-ai/mxbai-embed-large-v1", {
    dtype: "fp32",
  }).then((ext) => {
    logger.info("Model loaded successfully");
    return ext;
  });
  return extractorPromise;
}

export async function embedText(text: string): Promise<Float32Array> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: "cls", normalize: true });
  return new Float32Array(output.data);
}

export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const ext = await getExtractor();
  const results: Float32Array[] = [];
  for (const text of texts) {
    const output = await ext(text, { pooling: "cls", normalize: true });
    results.push(new Float32Array(output.data));
  }
  return results;
}

export function embeddingDimension(): number {
  return 1024;
}
