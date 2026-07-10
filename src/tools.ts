import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { logger } from "./logger.ts";

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

export const allTools = [readFileTool, writeFileTool, editFileTool, bashTool, listFilesTool];
