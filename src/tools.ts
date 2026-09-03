import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { logger } from "./logger.ts";
import { recallMemories, getMemoryStats, storeMessage, getStartupContext } from "./memory/index.ts";
import { installSkillFromUrl, saveSkill, removeSkill } from "./skills.ts";
import { queryMessages, getTopEntities, getEntityByNameFuzzy, getEntityRelationships, getMessagesForEntity, getRecentMessages } from "./memory/db.ts";
import type { Scheduler } from "./scheduler.ts";
import type { AgentRunner } from "./agent.ts";
import type { ThreadManager } from "./session.ts";

const EXA_MCP_URL = "https://mcp.exa.ai/mcp";

let exaRpcId = 0;
let exaInitialized = false;

async function exaJsonRpc(method: string, params?: Record<string, unknown>): Promise<any> {
  const isNotification = method.startsWith("notifications/");
  const id = isNotification ? undefined : ++exaRpcId;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const res = await fetch(EXA_MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body,
  });
  if (isNotification) return undefined;

  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";

  if (contentType.includes("text/event-stream")) {
    let lastResult: any = undefined;
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const data = JSON.parse(line.slice(6));
        if (data.error) throw new Error(`Exa MCP error: ${data.error.message}`);
        if (data.result !== undefined) lastResult = data.result;
      }
    }
    if (lastResult !== undefined) return lastResult;
    throw new Error("Exa MCP: no result in SSE response");
  }

  const json = JSON.parse(text);
  if (json.error) throw new Error(`Exa MCP error: ${json.error.message}`);
  return json.result;
}

async function ensureExaInit(): Promise<void> {
  if (exaInitialized) return;
  await exaJsonRpc("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "pi-spectrum", version: "0.1.0" },
  });
  await exaJsonRpc("notifications/initialized");
  exaInitialized = true;
}

async function callExaTool(name: string, args: Record<string, unknown>): Promise<string> {
  await ensureExaInit();
  const result = await exaJsonRpc("tools/call", { name, arguments: args });
  const content = result?.content;
  if (!Array.isArray(content) || content.length === 0) return "No results.";
  return content.map((c: any) => c.text ?? "").join("\n").trim() || "No results.";
}

const readFileSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read" }),
});

export const readFileTool: AgentTool<typeof readFileSchema> = {
  name: "readFile",
  label: "Read File",
  description: "Read the contents of a file at the given path",
  parameters: readFileSchema,
  async execute(_toolCallId, params) {
    logger.toolCall("readFile", params, _toolCallId);
    try {
      const content = readFileSync(params.path, "utf-8");
      logger.toolResult("readFile", { path: params.path, length: content.length }, false, _toolCallId);
      return {
        content: [{ type: "text", text: content }],
        details: { path: params.path, length: content.length },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("readFile", { path: params.path, error: msg }, true, _toolCallId);
      return {
        content: [{ type: "text", text: `Error reading file: ${msg}` }],
        details: {},
      };
    }
  },
};

const writeFileSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write" }),
  content: Type.String({ description: "Content to write to the file" }),
});

export const writeFileTool: AgentTool<typeof writeFileSchema> = {
  name: "writeFile",
  label: "Write File",
  description: "Write content to a file, creating directories if needed",
  parameters: writeFileSchema,
  async execute(_toolCallId, params) {
    logger.toolCall("writeFile", { path: params.path, contentLength: params.content.length }, _toolCallId);
    try {
      const dir = dirname(params.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(params.path, params.content, "utf-8");
      logger.toolResult("writeFile", { path: params.path, bytes: params.content.length }, false, _toolCallId);
      return {
        content: [{ type: "text", text: `Successfully wrote to ${params.path}` }],
        details: { path: params.path, bytes: params.content.length },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("writeFile", { path: params.path, error: msg }, true, _toolCallId);
      return {
        content: [{ type: "text", text: `Error writing file: ${msg}` }],
        details: {},
      };
    }
  },
};

const editFileSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit" }),
  oldString: Type.String({ description: "Exact string to find and replace" }),
  newString: Type.String({ description: "New string to replace with" }),
});

export const editFileTool: AgentTool<typeof editFileSchema> = {
  name: "editFile",
  label: "Edit File",
  description: "Edit a file by replacing an exact string match with new content",
  parameters: editFileSchema,
  async execute(_toolCallId, params) {
    logger.toolCall("editFile", { path: params.path, oldStringLength: params.oldString.length, newStringLength: params.newString.length }, _toolCallId);
    try {
      const content = readFileSync(params.path, "utf-8");
      if (!content.includes(params.oldString)) {
        logger.toolResult("editFile", { path: params.path, error: "String not found" }, true, _toolCallId);
        return {
          content: [{ type: "text", text: `String not found in ${params.path}` }],
          details: {},
        };
      }
      const newContent = content.replace(params.oldString, params.newString);
      writeFileSync(params.path, newContent, "utf-8");
      logger.toolResult("editFile", { path: params.path }, false, _toolCallId);
      return {
        content: [{ type: "text", text: `Successfully edited ${params.path}` }],
        details: { path: params.path },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("editFile", { path: params.path, error: msg }, true, _toolCallId);
      return {
        content: [{ type: "text", text: `Error editing file: ${msg}` }],
        details: {},
      };
    }
  },
};

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
});

export const bashTool: AgentTool<typeof bashSchema> = {
  name: "bash",
  label: "Bash",
  description: "Execute a bash command and return its output",
  parameters: bashSchema,
  async execute(_toolCallId, params) {
    logger.toolCall("bash", { command: params.command }, _toolCallId);
    try {
      const result = execSync(params.command, {
        encoding: "utf-8",
        timeout: 30000,
        cwd: process.cwd(),
      });
      logger.toolResult("bash", { command: params.command, outputLength: result.length }, false, _toolCallId);
      return {
        content: [{ type: "text", text: result || "(no output)" }],
        details: { command: params.command },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("bash", { command: params.command, error: msg }, true, _toolCallId);
      return {
        content: [{ type: "text", text: `Command failed: ${msg}` }],
        details: { command: params.command },
      };
    }
  },
};

const listFilesSchema = Type.Object({
  path: Type.String({ description: "Directory path to list" }),
});

export const listFilesTool: AgentTool<typeof listFilesSchema> = {
  name: "listFiles",
  label: "List Files",
  description: "List files and directories at the given path",
  parameters: listFilesSchema,
  async execute(_toolCallId, params) {
    logger.toolCall("listFiles", { path: params.path }, _toolCallId);
    try {
      const result = execSync(`ls -la "${params.path}"`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      logger.toolResult("listFiles", { path: params.path, outputLength: result.length }, false, _toolCallId);
      return {
        content: [{ type: "text", text: result }],
        details: { path: params.path },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("listFiles", { path: params.path, error: msg }, true, _toolCallId);
      return {
        content: [{ type: "text", text: `Error listing files: ${msg}` }],
        details: {},
      };
    }
  },
};

const webSearchSchema = Type.Object({
  query: Type.String({ description: "Natural language search query" }),
  numResults: Type.Optional(Type.Number({ description: "Number of results (default 10)" })),
});

export const webSearchTool: AgentTool<typeof webSearchSchema> = {
  name: "webSearch",
  label: "Web Search",
  description: "Search the web using Exa AI. Returns clean text content from top search results.",
  parameters: webSearchSchema,
  async execute(_toolCallId, params) {
    logger.toolCall("webSearch", params, _toolCallId);
    try {
      const args: Record<string, unknown> = { query: params.query };
      if (params.numResults) args.numResults = params.numResults;
      const text = await callExaTool("web_search_exa", args);
      logger.toolResult("webSearch", { query: params.query, length: text.length }, false, _toolCallId);
      return { content: [{ type: "text", text }], details: { query: params.query } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("webSearch", { query: params.query, error: msg }, true, _toolCallId);
      return { content: [{ type: "text", text: `Web search error: ${msg}` }], details: {} };
    }
  },
};

const webFetchSchema = Type.Object({
  urls: Type.Array(Type.String(), { description: "URLs to fetch content from" }),
  maxCharacters: Type.Optional(Type.Number({ description: "Max characters per page (default 3000)" })),
});

export const webFetchTool: AgentTool<typeof webFetchSchema> = {
  name: "webFetch",
  label: "Web Fetch",
  description: "Fetch full content from URLs as clean text using Exa.",
  parameters: webFetchSchema,
  async execute(_toolCallId, params) {
    logger.toolCall("webFetch", { urls: params.urls }, _toolCallId);
    try {
      const args: Record<string, unknown> = { urls: params.urls };
      if (params.maxCharacters) args.maxCharacters = params.maxCharacters;
      const text = await callExaTool("web_fetch_exa", args);
      logger.toolResult("webFetch", { urls: params.urls, length: text.length }, false, _toolCallId);
      return { content: [{ type: "text", text }], details: { urls: params.urls } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("webFetch", { urls: params.urls, error: msg }, true, _toolCallId);
      return { content: [{ type: "text", text: `Web fetch error: ${msg}` }], details: {} };
    }
  },
};

const installSkillSchema = Type.Object({
  url: Type.String({ description: "URL of a skill markdown document (e.g. https://example.com/skill.md)" }),
});

export const installSkillTool: AgentTool<typeof installSkillSchema> = {
  name: "installSkill",
  label: "Install Skill",
  description: "Install a skill from a URL. Fetches a markdown document of instructions/capabilities and adds it to your system prompt permanently. Use when the user asks you to install or add a skill.",
  parameters: installSkillSchema,
  async execute(_toolCallId, params) {
    logger.toolCall("installSkill", params, _toolCallId);
    try {
      const skill = await installSkillFromUrl(params.url);
      logger.toolResult("installSkill", { name: skill.name }, false, _toolCallId);
      return {
        content: [{ type: "text", text: `Installed skill "${skill.name}" (${skill.content.length} chars). It is now active in your system prompt from the next message onward. Preview:\n${skill.content.slice(0, 500)}` }],
        details: { name: skill.name },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("installSkill", { url: params.url, error: msg }, true, _toolCallId);
      return { content: [{ type: "text", text: `Failed to install skill: ${msg}` }], details: {} };
    }
  },
};

const createSkillSchema = Type.Object({
  name: Type.String({ description: "Short name for the skill (lowercase, hyphenated)" }),
  content: Type.String({ description: "The skill as a markdown document: what it does, when to apply it, and step-by-step instructions. May reference scripts to run via bash." }),
});

export const createSkillTool: AgentTool<typeof createSkillSchema> = {
  name: "createSkill",
  label: "Create Skill",
  description: "Author a new skill (or update an existing one by the same name) and save it permanently. The skill is injected into your system prompt so you can apply it in any future conversation. Use when the user asks you to create, write, or teach yourself a skill.",
  parameters: createSkillSchema,
  async execute(_toolCallId, params) {
    logger.toolCall("createSkill", { name: params.name, length: params.content.length }, _toolCallId);
    try {
      const skill = saveSkill(params.name, params.content);
      logger.toolResult("createSkill", { name: skill.name }, false, _toolCallId);
      return {
        content: [{ type: "text", text: `Saved skill "${skill.name}" (${skill.content.length} chars). It is active in your system prompt from the next message onward.` }],
        details: { name: skill.name },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("createSkill", { name: params.name, error: msg }, true, _toolCallId);
      return { content: [{ type: "text", text: `Failed to create skill: ${msg}` }], details: {} };
    }
  },
};

const removeSkillSchema = Type.Object({
  name: Type.String({ description: "Name of the installed skill to remove" }),
});

export const removeSkillTool: AgentTool<typeof removeSkillSchema> = {
  name: "removeSkill",
  label: "Remove Skill",
  description: "Remove a previously installed skill by name.",
  parameters: removeSkillSchema,
  async execute(_toolCallId, params) {
    logger.toolCall("removeSkill", params, _toolCallId);
    const removed = removeSkill(params.name);
    logger.toolResult("removeSkill", { name: params.name, removed }, !removed, _toolCallId);
    return {
      content: [{ type: "text", text: removed ? `Removed skill "${params.name}".` : `No installed skill named "${params.name}".` }],
      details: { removed },
    };
  },
};

const recallMemorySchema = Type.Object({
  query: Type.String({ description: "What to search for in memory (e.g. a person's name, topic, or situation)" }),
});

export const recallMemoryTool: AgentTool<typeof recallMemorySchema> = {
  name: "recallMemory",
  label: "Recall Memory",
  description: "Search your memory graph for past conversations, people, topics, and context. Use this when the user asks about something from a previous conversation or mentions a person/topic you might know about.",
  parameters: recallMemorySchema,
  async execute(_toolCallId, params) {
    logger.toolCall("recallMemory", params, _toolCallId);
    try {
      const { semanticMatches, entityMatches } = await recallMemories(params.query);
      const parts: string[] = [];

      if (entityMatches.length > 0) {
        parts.push("== Entities ==");
        for (const em of entityMatches.slice(0, 5)) {
          parts.push(`\n[${em.type}] ${em.name} (mentioned ${em.mentionCount}x)`);
          if (em.messages.length > 0) {
            parts.push("  Recent conversations:");
            for (const m of em.messages.slice(0, 3)) {
              const date = new Date(m.timestamp).toISOString().slice(0, 16);
              parts.push(`    ${date} (${m.sender}): ${m.text.slice(0, 200)}`);
            }
          }
          if (em.linked.length > 0) {
            parts.push(`  Related: ${em.linked.map((l) => `${l.name} (${l.type})`).join(", ")}`);
          }
        }
      }

      if (semanticMatches.length > 0) {
        parts.push("\n== Semantic Matches ==");
        for (const m of semanticMatches.slice(0, 5)) {
          const date = new Date(m.timestamp).toISOString().slice(0, 16);
          parts.push(`  [score: ${m.score.toFixed(3)}] ${date} (${m.sender}): ${m.text.slice(0, 300)}`);
        }
      }

      if (parts.length === 0) {
        parts.push("No memories found for this query.");
      }

      const stats = getMemoryStats();
      parts.push(`\n[Memory stats: ${stats.totalMessages} messages, ${stats.totalEntities} entities, ${stats.messagesWithEmbeddings} embedded]`);

      const text = parts.join("\n");
      logger.toolResult("recallMemory", { query: params.query, entities: entityMatches.length, semantic: semanticMatches.length }, false, _toolCallId);
      return { content: [{ type: "text", text }], details: { query: params.query } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("recallMemory", { query: params.query, error: msg }, true, _toolCallId);
      return { content: [{ type: "text", text: `Memory recall error: ${msg}` }], details: {} };
    }
  },
};

const storeMemorySchema = Type.Object({
  entities: Type.Array(
    Type.Object({
      name: Type.String({ description: "Full real name of the entity (resolve pronouns to real names)" }),
      type: Type.String({ description: "Type: person, place, organization, topic, activity, event, opinion, fact" }),
      context: Type.String({ description: "What about this entity? Include details from the conversation" }),
    }),
    { description: "Entities/facts to remember from this conversation" }
  ),
});

export const storeMemoryTool: AgentTool<typeof storeMemorySchema> = {
  name: "storeMemory",
  label: "Store Memory",
  description: "Silently store facts, people, places, and relationships in your memory graph. This is internal bookkeeping, invisible to the user - always give your real, natural reply to their message too, and never mention or confirm that you stored anything. Resolve pronouns to real names using conversation context.",
  parameters: storeMemorySchema,
  async execute(_toolCallId, params) {
    logger.toolCall("storeMemory", { count: params.entities.length, entities: params.entities.map((e) => e.name) }, _toolCallId);
    try {
      const timestamp = Date.now();
      const text = params.entities.map((e) => `${e.name}: ${e.context}`).join("\n");
      storeMessage({
        id: `mem-${timestamp}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp,
        sender: "user",
        role: "user",
        text,
        entities: params.entities.map((e) => ({ name: e.name, type: e.type, context: e.context })),
      }).catch((e) => logger.warn("Failed to store memory", { error: String(e) }));
      const resultText = `[internal, not visible to user] stored ${params.entities.length} item(s): ${params.entities.map((e) => e.name).join(", ")}. Do not mention or confirm this to the user - just continue your natural reply to their message.`;
      logger.toolResult("storeMemory", { stored: params.entities.length }, false, _toolCallId);
      return { content: [{ type: "text", text: resultText }], details: { entities: params.entities } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("storeMemory", { error: msg }, true, _toolCallId);
      return { content: [{ type: "text", text: `Failed to store memory: ${msg}` }], details: {} };
    }
  },
};

const getChatHistorySchema = Type.Object({
  sender: Type.Optional(Type.String({ description: "Filter by sender name" })),
  entity: Type.Optional(Type.String({ description: "Filter by entity/person mentioned" })),
  keyword: Type.Optional(Type.String({ description: "Filter by keyword in message text" })),
  since: Type.Optional(Type.String({ description: "Show messages after this date (ISO format or relative like '2h', '3d', '1w')" })),
  limit: Type.Optional(Type.Number({ description: "Max messages to return (default 30, max 100)" })),
});

export const getChatHistoryTool: AgentTool<typeof getChatHistorySchema> = {
  name: "getChatHistory",
  label: "Get Chat History",
  description: "Query your full chat history from the database. Filter by sender, entity, keyword, or time range. Returns chronological message thread. Use this to review past conversations in detail.",
  parameters: getChatHistorySchema,
  async execute(_toolCallId, params) {
    logger.toolCall("getChatHistory", params, _toolCallId);
    try {
      let sinceTimestamp: number | undefined;
      if (params.since) {
        const match = params.since.match(/^(\d+)([hdw])$/);
        if (match) {
          const num = parseInt(match[1], 10);
          const unit = match[2];
          const ms = unit === "h" ? 3600000 : unit === "d" ? 86400000 : 604800000;
          sinceTimestamp = Date.now() - num * ms;
        } else {
          const parsed = new Date(params.since).getTime();
          if (!isNaN(parsed)) sinceTimestamp = parsed;
        }
      }

      const limit = Math.min(params.limit ?? 30, 100);
      const messages = queryMessages({
        sender: params.sender,
        entityName: params.entity,
        keyword: params.keyword,
        sinceTimestamp,
        limit,
      });

      if (messages.length === 0) {
        return { content: [{ type: "text", text: "No messages found matching those filters." }], details: {} };
      }

      const lines = messages.map((m) => {
        const date = new Date(m.timestamp).toISOString().slice(0, 16).replace("T", " ");
        return `[${date}] ${m.sender}: ${m.text.slice(0, 500)}`;
      });

      const header = `== Chat History (${messages.length} messages) ==`;
      const text = [header, ...lines].join("\n");
      logger.toolResult("getChatHistory", { count: messages.length }, false, _toolCallId);
      return { content: [{ type: "text", text }], details: { count: messages.length } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("getChatHistory", { error: msg }, true, _toolCallId);
      return { content: [{ type: "text", text: `Chat history error: ${msg}` }], details: {} };
    }
  },
};

const getEntityInfoSchema = Type.Object({
  name: Type.String({ description: "Entity name to look up (person, place, topic, etc.)" }),
});

export const getEntityInfoTool: AgentTool<typeof getEntityInfoSchema> = {
  name: "getEntityInfo",
  label: "Get Entity Info",
  description: "Look up detailed information about a specific entity from your memory graph: who they are, their relationships, recent conversations, and linked entities. Use when you need deep context about a person or topic.",
  parameters: getEntityInfoSchema,
  async execute(_toolCallId, params) {
    logger.toolCall("getEntityInfo", { name: params.name }, _toolCallId);
    try {
      const entity = getEntityByNameFuzzy(params.name);
      if (!entity) {
        return { content: [{ type: "text", text: `No entity found matching "${params.name}".` }], details: {} };
      }

      const parts: string[] = [];
      parts.push(`== Entity: ${entity.name} ==`);
      parts.push(`Type: ${entity.type}`);
      parts.push(`Mentioned: ${entity.mentionCount}x`);
      if (entity.metadata) parts.push(`Metadata: ${JSON.stringify(entity.metadata)}`);

      const messages = getMessagesForEntity(entity.id, 10);
      if (messages.length > 0) {
        parts.push("\nRecent conversations:");
        for (const m of messages) {
          const date = new Date(m.timestamp).toISOString().slice(0, 16).replace("T", " ");
          parts.push(`  [${date}] ${m.sender}: ${m.text.slice(0, 300)}`);
        }
      }

      const rels = getEntityRelationships(entity.id);
      if (rels.length > 0) {
        parts.push("\nRelationships:");
        for (const r of rels) {
          parts.push(`  <-> ${r.entity.name} (${r.entity.type}) [${r.linkType}, weight: ${r.weight.toFixed(1)}, shared messages: ${r.sharedMessages}]`);
        }
      }

      const text = parts.join("\n");
      logger.toolResult("getEntityInfo", { name: params.name, messages: messages.length, relationships: rels.length }, false, _toolCallId);
      return { content: [{ type: "text", text }], details: { name: params.name } };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.toolResult("getEntityInfo", { error: msg }, true, _toolCallId);
      return { content: [{ type: "text", text: `Entity info error: ${msg}` }], details: {} };
    }
  },
};

export const allTools = [readFileTool, writeFileTool, editFileTool, bashTool, listFilesTool, webSearchTool, webFetchTool, installSkillTool, createSkillTool, removeSkillTool, recallMemoryTool, storeMemoryTool, getChatHistoryTool, getEntityInfoTool];

export interface ToolDeps {
  scheduler: Scheduler;
  agentRunner: AgentRunner;
  sendMessage: (text: string) => Promise<void>;
  threadManager?: ThreadManager;
}

// --- Timer Tools ---

const setTimerSchema = Type.Object({
  schedule: Type.String({ description: "Time until fire: seconds (e.g. '300') for <1 day, days (e.g. '3d') for >=1 day, or cron expression (e.g. '0 9 * * *') for fine-tuned scheduling" }),
  prompt: Type.String({ description: "Task to run when timer fires (e.g. 'remind me to check the deploy status')" }),
  silent: Type.Optional(Type.Boolean({ description: "If true, run the task without sending a response (default false)" })),
});

export function createSetTimerTool(deps: ToolDeps): AgentTool<typeof setTimerSchema> {
  return {
    name: "setTimer",
    label: "Set Timer",
    description: "Schedule a one-time task. Use seconds for <1 day (e.g. '300' for 5 min), days for >=1 day (e.g. '3d'). For fine-tuned scheduling, use cron syntax (validated). Returns the timer ID.",
    parameters: setTimerSchema,
    async execute(_toolCallId, params) {
      logger.toolCall("setTimer", { schedule: params.schedule, prompt: params.prompt.substring(0, 80), silent: params.silent }, _toolCallId);
      const result = deps.scheduler.setTimer(params.schedule, params.prompt, params.silent ?? false);
      if (result.error) {
        logger.toolResult("setTimer", { error: result.error }, true, _toolCallId);
        return { content: [{ type: "text", text: `Timer error: ${result.error}` }], details: {} };
      }
      logger.toolResult("setTimer", { id: result.id }, false, _toolCallId);
      return { content: [{ type: "text", text: `Timer set. ID: ${result.id}` }], details: { id: result.id } };
    },
  };
}

const setRecurringReminderSchema = Type.Object({
  cron: Type.String({ description: "Cron expression (5 fields: minute hour day-of-month month day-of-week). E.g. '0 9 * * *' for daily at 9am, '*/30 * * * *' for every 30 minutes" }),
  prompt: Type.String({ description: "Task to run when reminder fires" }),
  silent: Type.Optional(Type.Boolean({ description: "If true, run the task without sending a response (default false)" })),
});

export function createSetRecurringReminderTool(deps: ToolDeps): AgentTool<typeof setRecurringReminderSchema> {
  return {
    name: "setRecurringReminder",
    label: "Set Recurring Reminder",
    description: "Schedule a recurring task with cron syntax (5 fields). E.g. '0 9 * * *' = daily at 9am. Returns the reminder ID.",
    parameters: setRecurringReminderSchema,
    async execute(_toolCallId, params) {
      logger.toolCall("setRecurringReminder", { cron: params.cron, prompt: params.prompt.substring(0, 80), silent: params.silent }, _toolCallId);
      const result = deps.scheduler.setRecurringReminder(params.cron, params.prompt, params.silent ?? false);
      if (result.error) {
        logger.toolResult("setRecurringReminder", { error: result.error }, true, _toolCallId);
        return { content: [{ type: "text", text: `Reminder error: ${result.error}` }], details: {} };
      }
      logger.toolResult("setRecurringReminder", { id: result.id }, false, _toolCallId);
      return { content: [{ type: "text", text: `Recurring reminder set. ID: ${result.id}` }], details: { id: result.id } };
    },
  };
}

const cancelTimerSchema = Type.Object({
  id: Type.String({ description: "ID of the timer/reminder to cancel" }),
});

export function createCancelTimerTool(deps: ToolDeps): AgentTool<typeof cancelTimerSchema> {
  return {
    name: "cancelTimer",
    label: "Cancel Timer",
    description: "Cancel an active timer or reminder by its ID",
    parameters: cancelTimerSchema,
    async execute(_toolCallId, params) {
      logger.toolCall("cancelTimer", { id: params.id }, _toolCallId);
      const result = deps.scheduler.cancelTimer(params.id);
      if (!result.success) {
        logger.toolResult("cancelTimer", { error: result.error }, true, _toolCallId);
        return { content: [{ type: "text", text: `Cancel failed: ${result.error}` }], details: {} };
      }
      logger.toolResult("cancelTimer", { id: params.id }, false, _toolCallId);
      return { content: [{ type: "text", text: `Timer ${params.id} cancelled.` }], details: { id: params.id } };
    },
  };
}

const listTimersSchema = Type.Object({});

export function createListTimersTool(deps: ToolDeps): AgentTool<typeof listTimersSchema> {
  return {
    name: "listTimers",
    label: "List Timers",
    description: "List all active timers and reminders",
    parameters: listTimersSchema,
    async execute(_toolCallId, _params) {
      logger.toolCall("listTimers", {}, _toolCallId);
      const timers = deps.scheduler.listTimers();
      if (timers.length === 0) {
        return { content: [{ type: "text", text: "No active timers or reminders." }], details: { count: 0 } };
      }
      const lines = timers.map((t) => {
        const type = t.type === "recurring" ? "recurring" : "one-off";
        const schedule = t.type === "recurring" ? `cron: ${t.schedule}` : `schedule: ${t.schedule}`;
        const nextFire = t.fireAt
          ? `fires: ${new Date(t.fireAt).toLocaleString()}`
          : t.nextFire
            ? `next: ${new Date(t.nextFire).toLocaleString()}`
            : "";
        const status = t.enabled ? "active" : "disabled";
        const silent = t.silent ? " [silent]" : "";
        return `[${t.id.slice(0, 8)}] ${type} ${schedule} | "${t.prompt.substring(0, 60)}" | ${status} ${nextFire}${silent}`;
      });
      const text = `${timers.length} timer(s):\n${lines.join("\n")}`;
      logger.toolResult("listTimers", { count: timers.length }, false, _toolCallId);
      return { content: [{ type: "text", text }], details: { count: timers.length } };
    },
  };
}

// --- Direct Agent Access Tools ---

const runAgentTaskSchema = Type.Object({
  prompt: Type.String({ description: "Task to run through the agent loop" }),
  silent: Type.Optional(Type.Boolean({ description: "If true, don't send the result to the user (default false)" })),
});

export function createRunAgentTaskTool(deps: ToolDeps): AgentTool<typeof runAgentTaskSchema> {
  return {
    name: "runAgentTask",
    label: "Run Agent Task",
    description: "Run a task through the agent loop directly, generating a response. Use this to execute complex multi-step tasks autonomously.",
    parameters: runAgentTaskSchema,
    async execute(_toolCallId, params) {
      logger.toolCall("runAgentTask", { prompt: params.prompt.substring(0, 80), silent: params.silent }, _toolCallId);
      try {
        let response = "";
        for await (const event of deps.agentRunner.prompt(params.prompt)) {
          if (event.type === "message_end" && event.message.role === "assistant") {
            for (const block of event.message.content) {
              if (block.type === "text") {
                response = block.text;
              }
            }
          }
        }
        if (!params.silent && response) {
          await deps.sendMessage(response);
        }
        logger.toolResult("runAgentTask", { responseLength: response.length, silent: params.silent ?? false }, false, _toolCallId);
        return { content: [{ type: "text", text: params.silent ? "[silent task completed]" : `Task completed. Response sent to user.` }], details: { responseLength: response.length } };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.toolResult("runAgentTask", { error: msg }, true, _toolCallId);
        return { content: [{ type: "text", text: `Task failed: ${msg}` }], details: {} };
      }
    },
  };
}

const sendMessageSchema = Type.Object({
  message: Type.String({ description: "Message to send to the user" }),
});

export function createSendMessageTool(deps: ToolDeps): AgentTool<typeof sendMessageSchema> {
  return {
    name: "sendMessage",
    label: "Send Message",
    description: "Send a message to the user directly, bypassing the normal response flow",
    parameters: sendMessageSchema,
    async execute(_toolCallId, params) {
      logger.toolCall("sendMessage", { message: params.message.substring(0, 80) }, _toolCallId);
      try {
        await deps.sendMessage(params.message);
        logger.toolResult("sendMessage", { length: params.message.length }, false, _toolCallId);
        return { content: [{ type: "text", text: `Message sent.` }], details: { length: params.message.length } };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger.toolResult("sendMessage", { error: msg }, true, _toolCallId);
        return { content: [{ type: "text", text: `Failed to send message: ${msg}` }], details: {} };
      }
    },
  };
}

const startFreshSessionSchema = Type.Object({
  reason: Type.Optional(Type.String({ description: "Brief internal note on why this is a new topic (for logs)" })),
});

export function createStartFreshSessionTool(deps: ToolDeps): AgentTool<typeof startFreshSessionSchema> {
  return {
    name: "startFreshSession",
    label: "Start Fresh Session",
    description: "Silently reset the conversation to a clean session. Call this ONLY as your FIRST action, before replying, when the user's newest message is clearly a NEW, unrelated topic that does not follow from the current conversation context. After you call it, the conversation restarts with no prior context and the user's message will be answered fresh. This is completely invisible to the user - never mention, confirm, or reference it. If you call this, do not also write a reply in this turn; just end your turn.",
    parameters: startFreshSessionSchema,
    async execute(_toolCallId, params) {
      logger.toolCall("startFreshSession", { reason: params.reason }, _toolCallId);
      if (!deps.threadManager) {
        logger.toolResult("startFreshSession", { error: "no thread manager" }, true, _toolCallId);
        return { content: [{ type: "text", text: "[internal] session reset unavailable in this context; just answer normally." }], details: {} };
      }
      deps.threadManager.requestFreshRestart();
      logger.toolResult("startFreshSession", { reason: params.reason ?? "" }, false, _toolCallId);
      return {
        content: [{ type: "text", text: "[internal, not visible to user] Fresh session queued. End your turn now without replying - the user's message will be answered automatically in a clean session. Do not mention this." }],
        details: { reason: params.reason },
      };
    },
  };
}

export function createAllTools(deps: ToolDeps): AgentTool<any>[] {
  return [
    ...allTools,
    createSetTimerTool(deps),
    createSetRecurringReminderTool(deps),
    createCancelTimerTool(deps),
    createListTimersTool(deps),
    createRunAgentTaskTool(deps),
    createSendMessageTool(deps),
    createStartFreshSessionTool(deps),
  ];
}
