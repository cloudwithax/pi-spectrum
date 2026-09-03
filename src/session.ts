import type { Model, Context } from "@earendil-works/pi-ai";
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import { xiaomiTokenPlanSgpProvider } from "@earendil-works/pi-ai/providers/xiaomi-token-plan-sgp";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type { Config } from "./config.ts";
import type { AgentRunner } from "./agent.ts";
import { getLlmApiKey } from "./llm-auth.ts";
import { logger } from "./logger.ts";

type UserContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
      | { type: "audio"; data: string; format: string }
      | { type: "video"; data: string; mimeType: string }
    >;

export interface ThreadManager {
  /**
   * Run a user turn with smart thread detection. Yields the same AgentEvents
   * as agentRunner.prompt so existing consumers work unchanged. If the message
   * starts a new topic, the session is reset before the turn. If the agent
   * invokes the startFreshSession tool mid-turn (safety net), the session is
   * reset and the message is re-run cleanly - the caller only ever surfaces
   * the final (fresh) response.
   */
  runTurn: (userContent: UserContent) => AsyncGenerator<AgentEvent, void>;
  /** Called by the startFreshSession tool to queue a behind-the-scenes reset. */
  requestFreshRestart: () => void;
}

const CLASSIFIER_SYSTEM = `You classify whether an incoming message continues an ongoing chat thread or starts a new, unrelated one.

You are given the RECENT CONVERSATION and a NEW MESSAGE. Decide:
- CONTINUE: the new message follows on from, references, or is part of the same topic/task/flow as the recent conversation (including short replies like "yes", "and?", "what about X", clarifications, or resuming after a pause).
- NEW: the new message is clearly about a different, unrelated subject with no connection to the recent conversation.

Err toward CONTINUE when uncertain. Reply with exactly one word: CONTINUE or NEW.`;

function extractText(userContent: UserContent): string {
  if (typeof userContent === "string") return userContent;
  return userContent
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n");
}

export function createThreadManager(config: Config, runner: AgentRunner): ThreadManager {
  let classifierModel: Model<any>;
  if (config.llm.provider === "anthropic") {
    const catalogModel = getModel("anthropic", config.llm.classifierModel as any);
    if (!catalogModel) throw new Error(`Unknown anthropic classifier model: ${config.llm.classifierModel}`);
    // Clone so we can force reasoning off and a tiny output for fast, cheap classification.
    classifierModel = { ...(catalogModel as Model<any>), reasoning: false, maxTokens: 16 };
  } else {
    // Ensure the provider is registered for completeSimple dispatch.
    xiaomiTokenPlanSgpProvider();
    classifierModel = {
      id: config.llm.classifierModel,
      name: config.llm.classifierModel,
      api: "openai-completions",
      provider: "xiaomi-token-plan-sgp",
      baseUrl: config.llm.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1048576,
      maxTokens: 8,
    } satisfies Model<"openai-completions">;
  }

  let freshRestartRequested = false;

  async function classifyIsNewTopic(recentText: string, userText: string): Promise<boolean> {
    const context: Context = {
      systemPrompt: CLASSIFIER_SYSTEM,
      messages: [
        {
          role: "user",
          content: `RECENT CONVERSATION:\n${recentText || "(none)"}\n\nNEW MESSAGE:\n${userText}\n\nAnswer with one word: CONTINUE or NEW.`,
          timestamp: Date.now(),
        },
      ],
      tools: [],
    };
    try {
      const res = await completeSimple(classifierModel, context, { apiKey: getLlmApiKey(config) });
      const text = res.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join(" ")
        .toUpperCase();
      const isNew = /\bNEW\b/.test(text) && !/\bCONTINUE\b/.test(text);
      logger.info("THREAD_CLASSIFY", { decision: isNew ? "NEW" : "CONTINUE", raw: text.trim().slice(0, 40) });
      return isNew;
    } catch (e) {
      logger.warn("Thread classify failed, defaulting to CONTINUE", { error: String(e) });
      return false;
    }
  }

  async function shouldReset(userText: string): Promise<{ reset: boolean; reason: string }> {
    if (!config.thread.enabled) return { reset: false, reason: "disabled" };

    const s = runner.getSession();
    if (s.messageCount === 0) return { reset: false, reason: "empty-session" };

    const gap = Date.now() - s.lastActivityAt;
    // Cached "in context" flag: while the thread is warm we don't pay for a
    // classifier call - rapid back-and-forth is assumed to be one thread.
    if (gap < config.thread.warmWindowMs) {
      return { reset: false, reason: `warm-cache(${Math.round(gap / 1000)}s)` };
    }

    const isNew = await classifyIsNewTopic(runner.getRecentText(8), userText);
    return { reset: isNew, reason: isNew ? "classifier-new" : "classifier-continue" };
  }

  async function* runTurn(userContent: UserContent): AsyncGenerator<AgentEvent, void> {
    const userText = extractText(userContent);

    const decision = await shouldReset(userText);
    logger.info("THREAD_DECISION", {
      reset: decision.reset,
      reason: decision.reason,
      sessionMessages: runner.getSession().messageCount,
    });
    if (decision.reset) runner.startNewSession();

    // Clear any stale restart request before the turn.
    freshRestartRequested = false;

    yield* runner.prompt(userContent) as AsyncGenerator<AgentEvent, AgentMessage[]>;

    // Safety net: the agent decided mid-turn that this message did not belong
    // to the (kept) context. Reset silently and re-run the message clean.
    if (freshRestartRequested) {
      freshRestartRequested = false;
      logger.info("THREAD_SAFETY_RESTART", { note: "agent-invoked fresh session, re-running message clean" });
      runner.startNewSession();
      yield* runner.prompt(userContent) as AsyncGenerator<AgentEvent, AgentMessage[]>;
    }
  }

  return {
    runTurn,
    requestFreshRestart: () => {
      freshRestartRequested = true;
      logger.info("THREAD_FRESH_RESTART_REQUESTED");
    },
  };
}
