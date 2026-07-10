import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const LOG_DIR = process.env.LOG_DIR || "./logs";

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function timestamp(): string {
  return new Date().toISOString();
}

function logToFile(filename: string, data: Record<string, unknown>): void {
  const entry = JSON.stringify({ timestamp: timestamp(), ...data }) + "\n";
  appendFileSync(join(LOG_DIR, filename), entry);
}

export const logger = {
  info(message: string, data?: Record<string, unknown>): void {
    const entry = { level: "info", message, ...data };
    console.log(`[${timestamp()}] INFO ${message}`, data ? JSON.stringify(data) : "");
    logToFile("info.jsonl", entry);
  },

  warn(message: string, data?: Record<string, unknown>): void {
    const entry = { level: "warn", message, ...data };
    console.warn(`[${timestamp()}] WARN ${message}`, data ? JSON.stringify(data) : "");
    logToFile("warn.jsonl", entry);
  },

  error(message: string, data?: Record<string, unknown>): void {
    const entry = { level: "error", message, ...data };
    console.error(`[${timestamp()}] ERROR ${message}`, data ? JSON.stringify(data) : "");
    logToFile("error.jsonl", entry);
  },

  debug(message: string, data?: Record<string, unknown>): void {
    const entry = { level: "debug", message, ...data };
    if (process.env.DEBUG) {
      console.debug(`[${timestamp()}] DEBUG ${message}`, data ? JSON.stringify(data) : "");
    }
    logToFile("debug.jsonl", entry);
  },

  incoming(platform: string, sender: string, text: string, messageId: string): void {
    const entry = { platform, sender, text, messageId };
    console.log(`[${timestamp()}] INCOMING [${platform}] ${sender}: ${text}`);
    logToFile("incoming.jsonl", entry);
  },

  outgoing(spaceId: string, text: string): void {
    const entry = { spaceId, text };
    console.log(`[${timestamp()}] OUTGOING -> ${spaceId}: ${text.substring(0, 200)}${text.length > 200 ? "..." : ""}`);
    logToFile("outgoing.jsonl", entry);
  },

  agentStart(messageId: string): void {
    logToFile("agent.jsonl", { event: "agent_start", messageId });
  },

  agentEnd(messageId: string, messageCount: number): void {
    logToFile("agent.jsonl", { event: "agent_end", messageId, messageCount });
  },

  turnStart(messageId: string): void {
    logToFile("agent.jsonl", { event: "turn_start", messageId });
  },

  turnEnd(messageId: string, message: unknown): void {
    logToFile("agent.jsonl", { event: "turn_end", messageId, message });
  },

  toolCall(toolName: string, args: unknown, messageId: string): void {
    const entry = { event: "tool_call", toolName, args, messageId };
    console.log(`[${timestamp()}] TOOL_CALL ${toolName}`);
    logToFile("tools.jsonl", entry);
  },

  toolResult(toolName: string, result: unknown, isError: boolean, messageId: string): void {
    const entry = { event: "tool_result", toolName, result, isError, messageId };
    console.log(`[${timestamp()}] TOOL_RESULT ${toolName} ${isError ? "(error)" : "(ok)"}`);
    logToFile("tools.jsonl", entry);
  },

  llmRequest(model: string, messageCount: number): void {
    logToFile("llm.jsonl", { event: "request", model, messageCount });
  },

  llmResponse(model: string, stopReason: string, usage: unknown): void {
    logToFile("llm.jsonl", { event: "response", model, stopReason, usage });
  },

  llmError(error: string, model: string): void {
    logToFile("llm.jsonl", { event: "error", model, error });
  },

  raw(data: unknown): void {
    logToFile("raw.jsonl", { data });
  },
};
