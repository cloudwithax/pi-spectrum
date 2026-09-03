import { xiaomiTokenPlanSgpProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp";
import type { Model, Context, SimpleStreamOptions, AssistantMessageEventStream, UserMessage, Message, ImageContent, AudioContent, VideoContent } from "@earendil-works/pi-ai";
import { streamSimple, completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { agentLoop, type AgentEvent, type AgentMessage, type AgentLoopConfig, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Config } from "./config.ts";
import { allTools } from "./tools.ts";
import { logger } from "./logger.ts";
import { storeMessage } from "./memory/index.ts";
import { buildSystemPrompt } from "./soul.ts";
import { getLlmApiKey, getApiKeyForProvider, hasAnthropicAuth } from "./llm-auth.ts";
import { createMediaSidecar } from "./media-sidecar.ts";
import { randomUUID } from "node:crypto";

type InputPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; format: string }
  | { type: "video"; data: string; mimeType: string };

export interface SessionInfo {
  id: string;
  messageCount: number;
  startedAt: number;
  lastActivityAt: number;
}

export interface AgentRunner {
  prompt: (message: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "audio"; data: string; format: string } | { type: "video"; data: string; mimeType: string }>) => AsyncGenerator<AgentEvent, AgentMessage[]>;
  stop: () => void;
  setTools: (tools: AgentTool<any>[]) => void;
  /** Clear the in-memory conversation and begin a fresh session. Memory graph is untouched. */
  startNewSession: () => void;
  /** Metadata about the current session (used by thread detection). */
  getSession: () => SessionInfo;
  /** Recent user/assistant text from the current session, oldest-first, for the classifier. */
  getRecentText: (limit?: number) => string;
  /** Switch the active model at runtime. */
  setModel: (modelId: string) => void;
  /** Get the current model id. */
  getModel: () => string;
}

export function createAgentRunner(config: Config): AgentRunner {
  // The main model natively handles audio/video only on the xiaomi/MiMo path.
  // For anthropic we route media through the MiMo sidecar.
  const mainSupportsMedia = config.llm.provider === "xiaomi-token-plan-sgp";
  const mediaSidecar = createMediaSidecar(config);

  function buildAnthropicModel(modelId: string): Model<any> {
    const catalogModel = getModel("anthropic", modelId as any);
    if (!catalogModel) throw new Error(`Unknown anthropic model: ${modelId}`);
    return catalogModel as Model<any>;
  }

  function buildXiaomiModel(modelId: string): Model<any> {
    xiaomiTokenPlanSgpProvider();
    return {
      id: modelId,
      name: modelId,
      api: "openai-completions",
      provider: "xiaomi-token-plan-sgp",
      baseUrl: config.llm.baseUrl,
      reasoning: true,
      input: ["text", "image", "audio", "video"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1048576,
      maxTokens: 131072,
      compat: {
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
    } satisfies Model<"openai-completions">;
  }

  let model: Model<any> =
    config.llm.provider === "anthropic" ? buildAnthropicModel(config.llm.model) : buildXiaomiModel(config.llm.model);

  // Cross-provider fallback: if the main provider errors mid-prompt we retry
  // once on the other provider, when its credentials are available.
  let fallbackModel: Model<any> | null = null;
  if (config.llm.provider === "anthropic") {
    if (config.llm.baseUrl && config.llm.apiKey) fallbackModel = buildXiaomiModel(config.media.model);
  } else if (hasAnthropicAuth()) {
    fallbackModel = buildAnthropicModel("claude-sonnet-5");
  }
  logger.info("Agent model configured", {
    provider: config.llm.provider,
    model: model.id,
    fallbackModel: fallbackModel?.id ?? null,
    mediaSidecar: mediaSidecar.enabled && !mainSupportsMedia,
  });

  async function preprocessParts(parts: InputPart[]): Promise<InputPart[]> {
    const out: InputPart[] = [];
    for (const p of parts) {
      if (p.type === "audio") {
        const t = await mediaSidecar.transcribeAudio(p.data, p.format);
        out.push({ type: "text", text: `[Voice memo transcript]\n${t}` });
      } else if (p.type === "video") {
        const t = await mediaSidecar.describeVideo(p.data, p.mimeType);
        out.push({ type: "text", text: `[Video]\n${t}` });
      } else {
        out.push(p);
      }
    }
    return out;
  }

  let abortController: AbortController | null = null;
  let messages: AgentMessage[] = [];
  // Rolling summary of turns compacted out of the live message list. Injected
  // into the system prompt so long sessions stay coherent without replaying
  // the full transcript (which degrades the model badly).
  let sessionSummary = "";

  function estimateTokens(msgs: AgentMessage[]): number {
    let chars = 0;
    for (const m of msgs) chars += JSON.stringify(m).length;
    return Math.round(chars / 4);
  }

  function transcriptOf(msgs: AgentMessage[]): string {
    const lines: string[] = [];
    for (const m of msgs) {
      if (m.role === "user" || m.role === "assistant") {
        let text = "";
        if (typeof m.content === "string") text = m.content;
        else if (Array.isArray(m.content)) {
          text = m.content
            .map((b: any) => {
              if (b.type === "text") return b.text;
              if (b.type === "toolCall") return `[called tool ${b.name}]`;
              if (b.type === "image") return "[image]";
              return "";
            })
            .filter(Boolean)
            .join(" ");
        }
        text = text.trim();
        if (text) lines.push(`${m.role}: ${text.slice(0, 2000)}`);
      } else if (m.role === "toolResult") {
        const text = (Array.isArray((m as any).content) ? (m as any).content : [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join(" ")
          .trim();
        if (text) lines.push(`tool result: ${text.slice(0, 500)}`);
      }
    }
    return lines.join("\n");
  }

  async function compactIfNeeded(): Promise<void> {
    const est = estimateTokens(messages);
    if (est < config.session.compactTokens) return;

    // Keep the recent tail verbatim; advance the cut to a user-message boundary
    // so we never orphan a toolResult from its assistant toolCall.
    let cut = Math.max(0, messages.length - config.session.keepMessages);
    while (cut < messages.length && messages[cut].role !== "user") cut++;
    if (cut <= 0 || cut >= messages.length) return;

    const old = messages.slice(0, cut);
    const transcript = transcriptOf(old);
    logger.info("SESSION_COMPACT_START", { estTokens: est, compacting: old.length, keeping: messages.length - cut });

    try {
      const summarizerModel: Model<any> = { ...model, reasoning: false, maxTokens: 1024 };
      const res = await completeSimple(
        summarizerModel,
        {
          systemPrompt:
            "You maintain a running summary of a chat conversation. Merge the previous summary (if any) with the new transcript into ONE updated summary under 300 words. Preserve exactly: names of people/places/things, concrete facts, decisions made, user preferences, unresolved questions, and anything the user asked to be remembered. Never invent details. Output only the summary text.",
          messages: [
            {
              role: "user",
              content: `PREVIOUS SUMMARY:\n${sessionSummary || "(none)"}\n\nNEW TRANSCRIPT:\n${transcript}`,
              timestamp: Date.now(),
            },
          ],
          tools: [],
        },
        { apiKey: getLlmApiKey(config) },
      );
      const text = res.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n")
        .trim();
      if (text) sessionSummary = text;
      messages = messages.slice(cut);
      logger.info("SESSION_COMPACT_DONE", { summaryLength: sessionSummary.length, remainingMessages: messages.length });
    } catch (e) {
      // Still truncate so context stops growing; the memory graph retains the
      // full history for recall even though the summary update failed.
      messages = messages.slice(cut);
      logger.warn("SESSION_COMPACT_SUMMARY_FAILED", { error: String(e), remainingMessages: messages.length });
    }
  }
  let currentTools: AgentTool<any>[] = allTools;
  let sessionId = randomUUID();
  let sessionStartedAt = Date.now();
  let lastActivityAt = Date.now();

  const streamFn = (
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    logger.llmRequest(model.id, context.messages.length);
    logger.debug("LLM request details", {
      model: model.id,
      provider: model.provider,
      baseUrl: model.baseUrl,
      messageCount: context.messages.length,
      systemPromptLength: context.systemPrompt?.length ?? 0,
      toolCount: context.tools?.length ?? 0,
    });
    return streamSimple(model, context, {
      ...options,
      apiKey: getApiKeyForProvider(model.provider as Config["llm"]["provider"], config),
    });
  };

  function convertToLlm(msgs: AgentMessage[]): Message[] {
    return msgs
      .map((m): Message | undefined => {
        switch (m.role) {
          case "user":
          case "assistant":
          case "toolResult":
            return m;
          default:
            return undefined;
        }
      })
      .filter((m): m is Message => m !== undefined);
  }

  async function* prompt(userMessage: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "audio"; data: string; format: string } | { type: "video"; data: string; mimeType: string }>): AsyncGenerator<AgentEvent, AgentMessage[]> {
    abortController = new AbortController();
    lastActivityAt = Date.now();

    // Build content: string for plain text, array for multimodal
    let content: string | Array<{ type: "text"; text: string } | ImageContent | AudioContent | VideoContent>;
    let textForMemory: string;

    if (typeof userMessage === "string") {
      content = userMessage;
      textForMemory = userMessage;
    } else {
      // Convert audio/video to text via the sidecar when the main model can't
      // ingest them natively (e.g. anthropic).
      const parts = mainSupportsMedia ? userMessage : await preprocessParts(userMessage);
      content = parts.map((p) => {
        if (p.type === "text") return { type: "text" as const, text: p.text };
        if (p.type === "audio") return { type: "audio" as const, data: p.data, format: p.format as AudioContent["format"] };
        if (p.type === "video") return { type: "video" as const, data: p.data, mimeType: p.mimeType };
        return { type: "image" as const, data: p.data, mimeType: p.mimeType };
      });
      textForMemory = parts.filter((p) => p.type === "text").map((p) => (p as any).text).join("\n");
    }

    const agentMessage: UserMessage = {
      role: "user",
      content,
      timestamp: Date.now(),
    };

    logger.debug("Creating agent prompt", {
      userMessage: textForMemory,
      existingMessages: messages.length,
      hasImages: Array.isArray(content) && content.some((p) => p.type === "image"),
      hasAudio: Array.isArray(content) && content.some((p) => p.type === "audio"),
      hasVideo: Array.isArray(content) && content.some((p) => p.type === "video"),
    });

    await compactIfNeeded();

    const context = {
      systemPrompt:
        buildSystemPrompt() +
        (sessionSummary
          ? `\n\n## Earlier in this conversation (summary)\nOlder messages were compacted. Treat this as accurate history; if a detail you need isn't here, use recallMemory instead of guessing.\n${sessionSummary}`
          : ""),
      messages: [...messages],
      tools: currentTools,
    };

    const attempts: Model<any>[] = [model, ...(fallbackModel && fallbackModel.provider !== model.provider ? [fallbackModel] : [])];
    const errors: string[] = [];

    for (const attemptModel of attempts) {
      const isLastAttempt = attemptModel === attempts[attempts.length - 1];

      const agentConfig: AgentLoopConfig = {
        model: attemptModel,
        apiKey: getApiKeyForProvider(attemptModel.provider as Config["llm"]["provider"], config),
        convertToLlm,
      };

      const stream = agentLoop(
        [agentMessage],
        { ...context, messages: [...context.messages] },
        agentConfig,
        abortController.signal,
        streamFn,
      );

      let errored = false;
      for await (const event of stream) {
      logger.debug("Agent event", { event: event.type });

      if (event.type === "message_end" && event.message.role === "assistant") {
        const stopReason = (event.message as any).stopReason;
        const errorMessage = (event.message as any).errorMessage;

        if (stopReason === "error") {
          errored = true;
          errors.push(`${attemptModel.provider}/${attemptModel.id}: ${errorMessage || "unknown error"}`);
          logger.error("LLM API error", { errorMessage, model: attemptModel.id, provider: attemptModel.provider });
          // Don't push error messages into conversation history — they have empty
          // content and corrupt the context for future calls, causing cascading failures.
          // Also don't push the user message since there's no assistant response to pair it with.
          if (isLastAttempt || abortController.signal.aborted) {
            // No fallback left (or user aborted) — surface a combined error.
            (event.message as any).errorMessage =
              attempts.length > 1
                ? `All providers failed. ${errors.join("; ")}`
                : errorMessage;
            yield event;
            return messages;
          }
          logger.warn("Falling back to next provider", { from: attemptModel.provider, to: attempts[attempts.length - 1].provider });
          break; // abandon this stream, retry with the fallback model
        }

        messages.push(agentMessage);
        messages.push(event.message);
        logger.debug("Messages updated", { totalMessages: messages.length });

        const assistantText = event.message.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");

        storeMessage({
          id: agentMessage.timestamp?.toString() ?? Date.now().toString(),
          timestamp: agentMessage.timestamp ?? Date.now(),
          sender: "user",
          role: "user",
          text: textForMemory,
        }).catch((e) => logger.warn("Failed to store user message", { error: String(e) }));

        if (assistantText) {
          storeMessage({
            id: `assistant-${agentMessage.timestamp ?? Date.now()}`,
            timestamp: Date.now(),
            sender: "assistant",
            role: "assistant",
            text: assistantText,
          }).catch((e) => logger.warn("Failed to store assistant message", { error: String(e) }));
        }
      }

      yield event;
      }

      if (!errored) return messages;
    }

    return messages;
  }

  return {
    prompt,
    stop: () => {
      logger.info("Agent stopping");
      abortController?.abort();
    },
    setTools: (tools: AgentTool<any>[]) => {
      currentTools = tools;
      logger.debug("Agent tools updated", { toolCount: tools.length });
    },
    startNewSession: () => {
      const prevCount = messages.length;
      messages = [];
      sessionSummary = "";
      sessionId = randomUUID();
      sessionStartedAt = Date.now();
      lastActivityAt = Date.now();
      logger.info("SESSION_RESET", { sessionId, clearedMessages: prevCount });
    },
    getSession: () => ({
      id: sessionId,
      messageCount: messages.length,
      startedAt: sessionStartedAt,
      lastActivityAt,
    }),
    getRecentText: (limit = 8) => {
      const out: string[] = [];
      for (const m of messages) {
        if (m.role !== "user" && m.role !== "assistant") continue;
        let text = "";
        if (typeof m.content === "string") {
          text = m.content;
        } else if (Array.isArray(m.content)) {
          text = m.content
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join(" ");
        }
        text = text.trim();
        if (!text) continue;
        out.push(`${m.role}: ${text.slice(0, 240)}`);
      }
      return out.slice(-limit).join("\n");
    },
    setModel: (modelId: string) => {
      model = {
        ...model,
        id: modelId,
        name: modelId,
      };
      logger.info("Model switched", { model: modelId });
    },
    getModel: () => model.id,
  };
}
