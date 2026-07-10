import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export const readFileTool: AgentTool = {
  name: "readFile",
  label: "Read File",
  description: "Read the contents of a file at the given path",
  parameters: Type.Object({
    path: Type.String({ description: "Path to the file to read" }),
  }),
  async execute(_toolCallId, params) {
    try {
      const content = readFileSync(params.path, "utf-8");
      return {
        content: [{ type: "text", text: content }],
        details: { path: params.path, length: content.length },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error reading file: ${error instanceof Error ? error.message : String(error)}` }],
        details: {},
      };
    }
  },
};

export const writeFileTool: AgentTool = {
  name: "writeFile",
  label: "Write File",
  description: "Write content to a file, creating directories if needed",
  parameters: Type.Object({
    path: Type.String({ description: "Path to the file to write" }),
    content: Type.String({ description: "Content to write to the file" }),
  }),
  async execute(_toolCallId, params) {
    try {
      const dir = dirname(params.path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(params.path, params.content, "utf-8");
      return {
        content: [{ type: "text", text: `Successfully wrote to ${params.path}` }],
        details: { path: params.path, bytes: params.content.length },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error writing file: ${error instanceof Error ? error.message : String(error)}` }],
        details: {},
      };
    }
  },
};

export const editFileTool: AgentTool = {
  name: "editFile",
  label: "Edit File",
  description: "Edit a file by replacing an exact string match with new content",
  parameters: Type.Object({
    path: Type.String({ description: "Path to the file to edit" }),
    oldString: Type.String({ description: "Exact string to find and replace" }),
    newString: Type.String({ description: "New string to replace with" }),
  }),
  async execute(_toolCallId, params) {
    try {
      const content = readFileSync(params.path, "utf-8");
      if (!content.includes(params.oldString)) {
        return {
          content: [{ type: "text", text: `String not found in ${params.path}` }],
          details: {},
        };
      }
      const newContent = content.replace(params.oldString, params.newString);
      writeFileSync(params.path, newContent, "utf-8");
      return {
        content: [{ type: "text", text: `Successfully edited ${params.path}` }],
        details: { path: params.path },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error editing file: ${error instanceof Error ? error.message : String(error)}` }],
        details: {},
      };
    }
  },
};

export const bashTool: AgentTool = {
  name: "bash",
  label: "Bash",
  description: "Execute a bash command and return its output",
  parameters: Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
  }),
  async execute(_toolCallId, params) {
    try {
      const result = execSync(params.command, {
        encoding: "utf-8",
        timeout: 30000,
        cwd: process.cwd(),
      });
      return {
        content: [{ type: "text", text: result || "(no output)" }],
        details: { command: params.command },
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Command failed: ${msg}` }],
        details: { command: params.command },
      };
    }
  },
};

export const listFilesTool: AgentTool = {
  name: "listFiles",
  label: "List Files",
  description: "List files and directories at the given path",
  parameters: Type.Object({
    path: Type.String({ description: "Directory path to list" }),
  }),
  async execute(_toolCallId, params) {
    try {
      const result = execSync(`ls -la "${params.path}"`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      return {
        content: [{ type: "text", text: result }],
        details: { path: params.path },
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error listing files: ${error instanceof Error ? error.message : String(error)}` }],
        details: {},
      };
    }
  },
};

export const allTools = [readFileTool, writeFileTool, editFileTool, bashTool, listFilesTool];
