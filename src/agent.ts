import { xiaomiTokenPlanSgpProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp";
import type { Model, Context, SimpleStreamOptions, AssistantMessageEventStream, UserMessage, Message } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { agentLoop, type AgentEvent, type AgentMessage, type AgentLoopConfig } from "@earendil-works/pi-agent-core";
import type { Config } from "./config.ts";
import { allTools } from "./tools.ts";
import { logger } from "./logger.ts";

const SYSTEM_PROMPT = `You are an AI coding assistant integrated into iMessage. You can help with:
- Reading, writing, and editing files
- Running bash commands
- Exploring codebases
- Answering programming questions
- Writing and debugging code

You have access to tools for file operations and bash execution.
Be concise and helpful. When asked to write code, use the tools to create actual files.
When running commands, show the user the output.

You are connected via iMessage through Spectrum, the universal messaging platform.`;

export interface AgentRunner {
  prompt: (message: string) => AsyncGenerator<AgentEvent, AgentMessage[]>;
  stop: () => void;
}

export function createAgentRunner(config: Config): AgentRunner {
  const provider = xiaomiTokenPlanSgpProvider();
  const model: Model<"openai-completions"> = {
    id: config.llm.model,
    name: config.llm.model,
    api: "openai-completions",
    provider: "xiaomi-token-plan-sgp",
    baseUrl: config.llm.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1048576,
    maxTokens: 131072,
  };

  let abortController: AbortController | null = null;
  const messages: AgentMessage[] = [];

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
      apiKey: config.llm.apiKey,
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

  async function* prompt(userMessage: string): AsyncGenerator<AgentEvent, AgentMessage[]> {
    abortController = new AbortController();

    const agentMessage: UserMessage = {
      role: "user",
      content: userMessage,
      timestamp: Date.now(),
    };

    logger.debug("Creating agent prompt", {
      userMessage,
      existingMessages: messages.length,
    });

    const context = {
      systemPrompt: SYSTEM_PROMPT,
      messages: [...messages, agentMessage],
      tools: allTools,
    };

    const agentConfig: AgentLoopConfig = {
      model,
      apiKey: config.llm.apiKey,
      convertToLlm,
    };

    const stream = agentLoop(
      [agentMessage],
      context,
      agentConfig,
      abortController.signal,
      streamFn,
    );

    for await (const event of stream) {
      logger.debug("Agent event", { event: event.type });

      if (event.type === "message_end" && event.message.role === "assistant") {
        messages.push(agentMessage);
        messages.push(event.message);
        logger.debug("Messages updated", { totalMessages: messages.length });
      }

      yield event;
    }

    return messages;
  }

  return {
    prompt,
    stop: () => {
      logger.info("Agent stopping");
      abortController?.abort();
    },
  };
}
