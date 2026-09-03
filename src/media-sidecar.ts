import type { Model, Context, AudioContent, VideoContent } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { xiaomiTokenPlanSgpProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp";
import type { Config } from "./config.ts";
import { logger } from "./logger.ts";

/**
 * Multimodal sidecar: models like Anthropic Claude can't ingest audio/video,
 * so we route those through the natively-multimodal MiMo model to produce a
 * text transcript/description that the main model can reason over.
 */
export interface MediaSidecar {
  enabled: boolean;
  transcribeAudio: (dataB64: string, format: string) => Promise<string>;
  describeVideo: (dataB64: string, mimeType: string) => Promise<string>;
}

const AUDIO_PROMPT =
  "Transcribe any speech in this audio verbatim. Output only the transcript text, no preamble. " +
  "If there is no speech, briefly describe the sounds in one line.";

const VIDEO_PROMPT =
  "Describe what happens in this video concisely, and transcribe any speech verbatim. " +
  "Output plain text: a short description followed by any speech transcript.";

export function createMediaSidecar(config: Config): MediaSidecar {
  if (!config.media.enabled) {
    return {
      enabled: false,
      async transcribeAudio() { return "[voice memo received - transcription unavailable]"; },
      async describeVideo() { return "[video received - description unavailable]"; },
    };
  }

  xiaomiTokenPlanSgpProvider();

  const model: Model<"openai-completions"> = {
    id: config.media.model,
    name: config.media.model,
    api: "openai-completions",
    provider: "xiaomi-token-plan-sgp",
    baseUrl: config.media.baseUrl,
    reasoning: false,
    input: ["text", "image", "audio", "video"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 4096,
  };

  async function run(promptText: string, media: AudioContent | VideoContent, label: string): Promise<string> {
    const context: Context = {
      systemPrompt: "You are a precise media transcription and description engine.",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: promptText }, media],
          timestamp: Date.now(),
        },
      ],
      tools: [],
    };
    const res = await completeSimple(model, context, { apiKey: config.media.apiKey });
    const text = res.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("\n")
      .trim();
    logger.info("MEDIA_SIDECAR", { label, model: model.id, chars: text.length });
    return text;
  }

  return {
    enabled: true,
    async transcribeAudio(dataB64, format) {
      try {
        const media: AudioContent = { type: "audio", data: dataB64, format: format as AudioContent["format"] };
        const text = await run(AUDIO_PROMPT, media, "audio");
        return text || "[voice memo received - no speech detected]";
      } catch (e) {
        logger.warn("Media sidecar audio failed", { error: String(e) });
        return "[voice memo received - transcription failed]";
      }
    },
    async describeVideo(dataB64, mimeType) {
      try {
        const media: VideoContent = { type: "video", data: dataB64, mimeType };
        const text = await run(VIDEO_PROMPT, media, "video");
        return text || "[video received - no description]";
      } catch (e) {
        logger.warn("Media sidecar video failed", { error: String(e) });
        return "[video received - description failed]";
      }
    },
  };
}
