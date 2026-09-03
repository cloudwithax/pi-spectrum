import "dotenv/config";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.ts";
import { createAgentRunner } from "../src/agent.ts";

const VIDEO_PATH = "./workspace/test.mp4";

const config = loadConfig();
const agent = createAgentRunner(config);

const video = await readFile(VIDEO_PATH);
console.log(`Loaded ${VIDEO_PATH} (${video.length} bytes), sending to ${config.llm.model} via ${config.llm.baseUrl}...`);

const start = Date.now();
let response = "";

for await (const event of agent.prompt([
  { type: "video", data: video.toString("base64"), mimeType: "video/mp4" },
  { type: "text", text: "Describe what happens in this video in one or two sentences." },
])) {
  if (event.type === "message_end" && event.message.role === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "text") response = block.text;
    }
  }
  if (event.type === "agent_end") break;
}

console.log(`\nResponse (${((Date.now() - start) / 1000).toFixed(1)}s):\n${response}\n`);

if (!response) {
  console.error("FAIL: no response from model");
  process.exit(1);
}
console.log("PASS: model responded to video input");
process.exit(0);
