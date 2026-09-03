export type LlmProvider = "anthropic" | "xiaomi-token-plan-sgp";

export interface Config {
  mode: "spectrum" | "terminal";
  spectrum?: {
    projectId: string;
    projectSecret: string;
    webhookSecret?: string;
  };
  llm: {
    provider: LlmProvider;
    /** Base URL for the xiaomi/openai-completions main provider (unused for anthropic OAuth). */
    baseUrl: string;
    /** Static API key for the xiaomi main provider (anthropic resolves via OAuth). */
    apiKey: string;
    /** Main model id (e.g. "claude-sonnet-5" or "mimo-v2.5"). */
    model: string;
    /** Lightweight model used for thread classification. */
    classifierModel: string;
  };
  media: {
    /** Whether the multimodal MiMo sidecar is available for audio/video. */
    enabled: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  session: {
    /** Estimated token count above which older session messages are compacted
     * into a rolling summary. */
    compactTokens: number;
    /** Number of recent messages kept verbatim when compacting. */
    keepMessages: number;
  };
  thread: {
    /** Messages arriving within this window of the last activity are treated as
     * the same thread without invoking the classifier (cached "in context"). */
    warmWindowMs: number;
    /** Master switch for smart thread detection. */
    enabled: boolean;
  };
  workingDirectory: string;
}

export function loadConfig(): Config {
  const projectId = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;
  const webhookSecret = process.env.SPECTRUM_WEBHOOK_SECRET;

  const provider = (process.env.LLM_PROVIDER as LlmProvider) || "anthropic";

  // MiMo / xiaomi credentials: main provider when provider=xiaomi, and always
  // the multimodal sidecar for audio/video.
  const baseUrl = process.env.LLM_BASE_URL || "";
  const apiKey = process.env.LLM_API_KEY || "";
  const mediaModel = process.env.MEDIA_MODEL || "mimo-v2.5";

  const model = process.env.LLM_MODEL || (provider === "anthropic" ? "claude-sonnet-5" : "mimo-v2.5");
  const classifierModel = process.env.LLM_CLASSIFIER_MODEL || (provider === "anthropic" ? "claude-haiku-4-5" : model);

  const workingDirectory = process.env.WORKING_DIRECTORY || process.cwd();
  const compactTokens = process.env.SESSION_COMPACT_TOKENS ? parseInt(process.env.SESSION_COMPACT_TOKENS, 10) : 16000;
  const keepMessages = process.env.SESSION_KEEP_MESSAGES ? parseInt(process.env.SESSION_KEEP_MESSAGES, 10) : 12;
  const threadWarmWindowMs = process.env.THREAD_WARM_WINDOW_MS ? parseInt(process.env.THREAD_WARM_WINDOW_MS, 10) : 20 * 60 * 1000;
  const threadEnabled = process.env.THREAD_DETECTION !== "0";

  const mode: "spectrum" | "terminal" = process.env.MODE === "spectrum" && projectId && projectSecret ? "spectrum" : "terminal";

  // The xiaomi/MiMo endpoint is required as the main provider (provider=xiaomi)
  // and recommended as the media sidecar for anthropic.
  if (provider === "xiaomi-token-plan-sgp") {
    if (!baseUrl) throw new Error("LLM_BASE_URL is required for provider=xiaomi-token-plan-sgp");
    if (!apiKey) throw new Error("LLM_API_KEY is required for provider=xiaomi-token-plan-sgp");
  }

  const mediaEnabled = Boolean(baseUrl && apiKey);

  if (mode === "spectrum") {
    if (!projectId) throw new Error("SPECTRUM_PROJECT_ID is required for spectrum mode");
    if (!projectSecret) throw new Error("SPECTRUM_PROJECT_SECRET is required for spectrum mode");
  }

  return {
    mode,
    spectrum: mode === "spectrum" ? { projectId: projectId!, projectSecret: projectSecret!, webhookSecret } : undefined,
    llm: { provider, baseUrl, apiKey, model, classifierModel },
    media: { enabled: mediaEnabled, baseUrl, apiKey, model: mediaModel },
    session: { compactTokens, keepMessages },
    thread: { warmWindowMs: threadWarmWindowMs, enabled: threadEnabled },
    workingDirectory,
  };
}
