import "dotenv/config";
import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { loadConfig } from "./config.ts";
import { createAgentRunner } from "./agent.ts";
import { logger } from "./logger.ts";
import { stripMarkdown, splitResponse, DebounceQueue, sendPaced, type MessageAttachment, type QueuedMessage } from "./imessage-utils.ts";
import { initMemory, ensureModelReady } from "./memory/index.ts";
import { loadSoul, saveSoul, getSoul } from "./soul.ts";
import { createScheduler, type Scheduler } from "./scheduler.ts";
import { createThreadManager } from "./session.ts";
import { initAnthropicAuth } from "./llm-auth.ts";
import { createAllTools, type ToolDeps } from "./tools.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, unlink, readdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";

const execFileAsync = promisify(execFile);

const AVAILABLE_MODELS = ["mimo-v2.5", "mimo-v2-pro", "mimo-v2.5-pro"];

function fuzzyMatchModel(query: string): string | null {
  const q = query.toLowerCase().replace(/[^a-z0-9.]/g, "");
  // Exact match first
  const exact = AVAILABLE_MODELS.find((m) => m === q);
  if (exact) return exact;
  // Substring match
  const substring = AVAILABLE_MODELS.find((m) => m.includes(q));
  if (substring) return substring;
  // Strip dots/dashes and try again (e.g. "v25" matches "v2.5")
  const stripped = q.replace(/[\.\-]/g, "");
  const strippedMatch = AVAILABLE_MODELS.find((m) => m.replace(/[\.\-]/g, "").includes(stripped));
  if (strippedMatch) return strippedMatch;
  return null;
}

const AUDIO_EXTENSIONS = /\.(caf|m4a|mp3|wav|ogg|opus|aac|wma|flac)$/i;
const VIDEO_EXTENSIONS = /\.(mov|mp4|m4v|webm|3gp|avi|mkv)$/i;
const DOCUMENT_EXTENSIONS = /\.(pdf|txt|csv|json|xml|html|htm|md|rtf|doc|docx|xls|xlsx|ppt|pptx|pages|numbers|key)$/i;
const HEIC_MIMES = /^(image\/heic|image\/heif)$/i;
const HEIC_EXTS = /\.(heic|heif)$/i;

async function readWithRetry(readFn: () => Promise<Buffer>, retries = 2, delayMs = 1000): Promise<Buffer> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await readFn();
    } catch (err) {
      if (attempt < retries) {
        logger.debug("Retrying attachment read", { attempt: attempt + 1, retries, error: String(err) });
        await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

function isAudioAttachment(name?: string, mimeType?: string): boolean {
  if (mimeType?.startsWith("audio/")) return true;
  if (name && AUDIO_EXTENSIONS.test(name)) return true;
  return false;
}

function isVideoAttachment(name?: string, mimeType?: string): boolean {
  if (mimeType?.startsWith("video/")) return true;
  if (name && VIDEO_EXTENSIONS.test(name)) return true;
  return false;
}

function isDocumentAttachment(name?: string, mimeType?: string): boolean {
  if (mimeType === "application/pdf") return true;
  if (mimeType?.startsWith("text/")) return true;
  if (name && DOCUMENT_EXTENSIONS.test(name)) return true;
  return false;
}

async function convertCafToWav(buffer: Buffer): Promise<Buffer> {
  const tmpIn = join(tmpdir(), `voice-${randomUUID()}.caf`);
  const tmpOut = join(tmpdir(), `voice-${randomUUID()}.wav`);
  try {
    await writeFile(tmpIn, buffer);
    await new Promise<void>((resolve, reject) => {
      execFile("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", tmpIn,
        "-f", "wav",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        tmpOut,
      ], { maxBuffer: 10 * 1024 * 1024 }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    return await readFile(tmpOut);
  } finally {
    unlink(tmpIn).catch(() => {});
    unlink(tmpOut).catch(() => {});
  }
}

function isHeic(mimeType?: string, name?: string): boolean {
  if (mimeType && HEIC_MIMES.test(mimeType)) return true;
  if (name && HEIC_EXTS.test(name)) return true;
  return false;
}

async function convertHeicToPng(buffer: Buffer): Promise<Buffer> {
  const tmpIn = join(tmpdir(), `img-${randomUUID()}.heic`);
  const tmpOut = join(tmpdir(), `img-${randomUUID()}.png`);
  try {
    await writeFile(tmpIn, buffer);
    await execFileAsync("convert", [tmpIn, tmpOut], { maxBuffer: 50 * 1024 * 1024 });
    return await readFile(tmpOut);
  } finally {
    unlink(tmpIn).catch(() => {});
    unlink(tmpOut).catch(() => {});
  }
}

async function convertVideoToMp4(buffer: Buffer, inputMime?: string): Promise<Buffer> {
  const ext = inputMime?.includes("quicktime") ? "mov"
    : inputMime?.includes("webm") ? "webm"
    : inputMime?.includes("x-matroska") ? "mkv"
    : inputMime?.includes("avi") || inputMime?.includes("x-msvideo") ? "avi"
    : "mp4";
  const tmpIn = join(tmpdir(), `video-${randomUUID()}.${ext}`);
  const tmpOut = join(tmpdir(), `video-${randomUUID()}.mp4`);
  try {
    await writeFile(tmpIn, buffer);
    await new Promise<void>((resolve, reject) => {
      execFile("ffmpeg", [
        "-hide_banner",
        "-loglevel", "error",
        "-y",
        "-i", tmpIn,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        "-an",
        tmpOut,
      ], { maxBuffer: 50 * 1024 * 1024 }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
    return await readFile(tmpOut);
  } finally {
    unlink(tmpIn).catch(() => {});
    unlink(tmpOut).catch(() => {});
  }
}

const MAX_PDF_PAGES = 20;

async function convertPdfToImages(buffer: Buffer): Promise<Array<{ data: string; mimeType: string }>> {
  const tmpDir = await mkdtemp(join(tmpdir(), "pdf-"));
  const tmpIn = join(tmpDir, "input.pdf");
  const pagePrefix = join(tmpDir, "page");
  try {
    await writeFile(tmpIn, buffer);
    await execFileAsync("pdftoppm", [
      "-png",
      "-r", "150",
      tmpIn,
      pagePrefix,
    ], { maxBuffer: 50 * 1024 * 1024 });
    const files = (await readdir(tmpDir))
      .filter((f) => f.startsWith("page") && f.endsWith(".png"))
      .sort()
      .slice(0, MAX_PDF_PAGES);
    const images: Array<{ data: string; mimeType: string }> = [];
    for (const file of files) {
      const imgBuffer = await readFile(join(tmpDir, file));
      images.push({ data: imgBuffer.toString("base64"), mimeType: "image/png" });
    }
    return images;
  } finally {
    unlink(tmpIn).catch(() => {});
    const files = await readdir(tmpDir).catch(() => []);
    for (const f of files) {
      unlink(join(tmpDir, f)).catch(() => {});
    }
    unlink(tmpDir).catch(() => {});
  }
}

async function runTerminal(config: ReturnType<typeof loadConfig>) {
  const agent = createAgentRunner(config);

  logger.info("Starting pi-spectrum in TERMINAL mode", {
    model: config.llm.model,
    workingDirectory: config.workingDirectory,
  });
  console.log("pi-spectrum terminal mode. Type messages, Ctrl+C to exit.\n");

  // Create scheduler for terminal mode
  const scheduler: Scheduler = createScheduler({
    agentRunner: agent,
    sendMessage: async (msg: string) => {
      console.log(`\nagent> ${msg}\n`);
    },
  });

  // Smart thread detection
  const threadManager = createThreadManager(config, agent);

  // Set up tools
  const toolDeps: ToolDeps = { scheduler, agentRunner: agent, threadManager, sendMessage: async (msg: string) => { console.log(`\nagent> ${msg}\n`); } };
  agent.setTools(createAllTools(toolDeps));

  // Restore timers
  scheduler.restoreTimers().catch((e) => {
    logger.error("Failed to restore timers", { error: String(e) });
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (): void => {
    rl.question("you> ", async (input) => {
      const msgText = input.trim();
      if (!msgText) {
        prompt();
        return;
      }

      if (msgText.toLowerCase() === "/quit" || msgText.toLowerCase() === "/exit") {
        logger.info("Shutdown requested");
        scheduler.shutdown();
        rl.close();
        process.exit(0);
      }

      if (msgText.toLowerCase() === "/clear") {
        agent.startNewSession();
        console.log("\nContext cleared.\n");
        prompt();
        return;
      }

      if (msgText.toLowerCase() === "/soul") {
        const current = getSoul();
        console.log(current ? `\nCurrent SOUL.md:\n\n${current}\n` : "\nNo SOUL.md found.\n");
        prompt();
        return;
      }
      if (msgText.toLowerCase().startsWith("/soul ")) {
        const newSoul = msgText.slice(6).trim();
        if (newSoul) {
          saveSoul(newSoul);
          console.log("\nSOUL.md updated.\n");
        } else {
          console.log("\nUsage: /soul <your new personality>\n");
        }
        prompt();
        return;
      }

      if (msgText.toLowerCase() === "/model") {
        const current = agent.getModel();
        const list = AVAILABLE_MODELS.map((m) => m === current ? `${m} (active)` : m).join("\n");
        console.log(`\nCurrent model: ${current}\n\nAvailable:\n${list}\n\nType /model <name> to switch.\n`);
        prompt();
        return;
      }
      if (msgText.toLowerCase().startsWith("/model ")) {
        const query = msgText.slice(7).trim();
        if (!query) {
          console.log("\nUsage: /model <model name>\n");
        } else {
          const matched = fuzzyMatchModel(query);
          if (!matched) {
            console.log(`\nNo match for "${query}". Available: ${AVAILABLE_MODELS.join(", ")}\n`);
          } else {
            agent.setModel(matched);
            console.log(`\nSwitched to ${matched}.\n`);
          }
        }
        prompt();
        return;
      }

      logger.incoming("terminal", "user", msgText, Date.now().toString());

      try {
        let response = "";
        let lastStopReason: string | undefined;
        let lastErrorMessage: string | undefined;
        for await (const event of threadManager.runTurn(msgText)) {
          if (event.type === "agent_start") {
            logger.agentStart(msgText);
          }
          if (event.type === "turn_start") {
            logger.turnStart(msgText);
          }
          if (event.type === "message_update" && event.message.role === "assistant") {
            for (const block of event.message.content) {
              if (block.type === "toolCall") {
                logger.toolCall(block.name, block.arguments, msgText);
              }
            }
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            lastStopReason = event.message.stopReason;
            for (const block of event.message.content) {
              if (block.type === "text") {
                response = block.text;
              }
              if (block.type === "toolCall") {
                logger.toolCall(block.name, block.arguments, msgText);
              }
            }
            logger.llmResponse(config.llm.model, event.message.stopReason, event.message.usage);
            if (event.message.stopReason === "error") {
              lastErrorMessage = (event.message as any).errorMessage;
              logger.error("LLM returned error (terminal)", { errorMessage: lastErrorMessage });
            }
          }
          if (event.type === "tool_execution_start") {
            logger.toolCall(event.toolName, event.args, msgText);
          }
          if (event.type === "tool_execution_end") {
            logger.toolResult(event.toolName, event.result, event.isError, msgText);
          }
          if (event.type === "agent_end") {
            logger.agentEnd(msgText, event.messages.length);
          }
        }

        if (response) {
          logger.outgoing("terminal", response);
          console.log(`\nagent> ${response}\n`);
        } else if (lastStopReason === "error") {
          console.log(`\nagent> (LLM error — ${lastErrorMessage || "try again in a moment"})\n`);
        } else {
          logger.warn("No response generated");
          console.log("\nagent> (no response)\n");
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error("Error processing message", {
          error: errorMsg,
          stack: error instanceof Error ? error.stack : undefined,
        });
        console.log(`\nerror> ${errorMsg}\n`);
      }

      prompt();
    });
  };

  prompt();
}

async function runSpectrum(config: ReturnType<typeof loadConfig>) {
  const agent = createAgentRunner(config);

  logger.info("Starting pi-spectrum in SPECTRUM mode", {
    model: config.llm.model,
    workingDirectory: config.workingDirectory,
    projectId: config.spectrum!.projectId,
  });

  const app = await Spectrum({
    projectId: config.spectrum!.projectId,
    projectSecret: config.spectrum!.projectSecret,
    providers: [
      imessage.config(),
      terminal.config(),
    ],
  });

  logger.info("Connected to Spectrum. Listening for messages...");

  // Track last active space for proactive messaging (single-user)
  let lastSpace: any = null;

  // Create scheduler with deps
  const sendMessage = async (msg: string) => {
    if (!lastSpace) {
      logger.warn("No active space to send message to");
      return;
    }
    const clean = stripMarkdown(msg);
    await sendPaced(
      {
        send: (t) => lastSpace.send(text(t)),
        startTyping: () => lastSpace.startTyping(),
        stopTyping: () => lastSpace.stopTyping(),
      },
      splitResponse(clean),
    );
  };

  const scheduler: Scheduler = createScheduler({
    agentRunner: agent,
    sendMessage,
  });

  // Smart thread detection
  const threadManager = createThreadManager(config, agent);

  // Set up tools with dependencies
  const toolDeps: ToolDeps = { scheduler, agentRunner: agent, threadManager, sendMessage };
  agent.setTools(createAllTools(toolDeps));

  // Restore timers on startup
  scheduler.restoreTimers().catch((e) => {
    logger.error("Failed to restore timers", { error: String(e) });
  });

  // Agent-busy buffering: messages arriving while the agent is responding
  // are held and flushed as one combined prompt when the response finishes.
  let agentBusy = false;
  let pendingMessages: QueuedMessage[] = [];
  let pendingChatId: string | null = null;

  async function flushPending(): Promise<void> {
    if (pendingMessages.length === 0 || !pendingChatId) return;
    const msgs = pendingMessages.splice(0);
    const chat = pendingChatId;
    pendingChatId = null;
    debounce.flushSync(chat);
    await processMessages(chat, msgs);
  }

  async function processMessages(chatId: string, messages: QueuedMessage[]): Promise<void> {
    // Use the last message's context for the response
    const last = messages[messages.length - 1];
    const space = last.space;

    // Track last active space for proactive messaging
    lastSpace = space;

    logger.info("DEBOUNCE_FLUSH", { chatId, count: messages.length, ids: messages.map((m) => m.id) });

    agentBusy = true;

    await space?.responding(async () => {
      // If multiple messages accumulated, treat earlier ones as context
      // Build content array: text from all messages + images/audio/video from messages
      const allText = messages.map((m) => m.text).filter(Boolean).join("\n");
      const contentParts: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "audio"; data: string; format: string } | { type: "video"; data: string; mimeType: string }> = [];

      if (allText) {
        contentParts.push({ type: "text", text: allText });
      }

      // Attach images, audio and video from any message in the batch
      const MAX_IMAGES = 8;
      for (const m of messages) {
        if (m.attachments) {
          for (const att of m.attachments) {
            if (att.kind === "audio") {
              const format = att.mimeType.split("/")[1]?.split(";")[0] ?? "wav";
              contentParts.push({ type: "audio", data: att.data, format });
            } else if (att.kind === "video") {
              contentParts.push({ type: "video", data: att.data, mimeType: att.mimeType });
            } else if (att.kind === "image") {
              if (contentParts.filter((p) => p.type === "image").length >= MAX_IMAGES) {
                logger.warn("Too many images, dropping extras", { dropped: m.attachments.length });
                break;
              }
              contentParts.push({ type: "image", data: att.data, mimeType: att.mimeType });
            }
            // document-kind attachments are skipped here: text content is already in messageText,
            // and PDFs were converted to image-kind attachments above.
          }
        }
      }

      // Only log individual incoming for each message
      for (const m of messages) {
        logger.incoming(m.platform, m.sender, m.text, m.id);
      }

      // Handle commands from any message in the batch
      for (const m of messages) {
        if (m.text.toLowerCase() === "/quit" || m.text.toLowerCase() === "/exit") {
          logger.info("Shutdown requested");
          scheduler.shutdown();
          agent.stop();
          await app.stop();
          process.exit(0);
        }
        if (m.text.toLowerCase() === "/clear" || m.text.toLowerCase() === "/reset") {
          logger.info("Clear command received", { spaceId: chatId });
          agent.startNewSession();
          await space?.send(text("Context cleared."));
          return;
        }
        if (m.text.toLowerCase() === "/soul") {
          const current = getSoul();
          if (current) {
            await space?.send(text(`Current SOUL.md:\n\n${current}`));
          } else {
            await space?.send(text("No SOUL.md found. Send /soul followed by your new personality to create one."));
          }
          return;
        }
        if (m.text.toLowerCase().startsWith("/soul ")) {
          const newSoul = m.text.slice(6).trim();
          if (newSoul) {
            saveSoul(newSoul);
            await space?.send(text("SOUL.md updated. Personality changes take effect on the next message."));
          } else {
            await space?.send(text("Usage: /soul <your new personality>"));
          }
          return;
        }
        if (m.text.toLowerCase() === "/model") {
          const current = agent.getModel();
          const list = AVAILABLE_MODELS.map((m) => m === current ? `${m} (active)` : m).join("\n");
          await space?.send(text(`Current model: ${current}\n\nAvailable:\n${list}\n\nSend /model <name> to switch.`));
          return;
        }
        if (m.text.toLowerCase().startsWith("/model ")) {
          const query = m.text.slice(7).trim();
          if (!query) {
            await space?.send(text("Usage: /model <model name>"));
            return;
          }
          const matched = fuzzyMatchModel(query);
          if (!matched) {
            await space?.send(text(`No match for "${query}". Available: ${AVAILABLE_MODELS.join(", ")}`));
            return;
          }
          agent.setModel(matched);
          await space?.send(text(`Switched to ${matched}.`));
          return;
        }
      }

      try {
        let response = "";
        let lastStopReason: string | undefined;
        let lastErrorMessage: string | undefined;

        const userContent = contentParts.length === 1 && contentParts[0].type === "text"
          ? contentParts[0].text
          : contentParts;

        for await (const event of threadManager.runTurn(userContent)) {
          if (event.type === "agent_start") {
            logger.agentStart(last.id);
          }
          if (event.type === "turn_start") {
            logger.turnStart(last.id);
          }
          if (event.type === "message_update" && event.message.role === "assistant") {
            for (const block of event.message.content) {
              if (block.type === "toolCall") {
                logger.toolCall(block.name, block.arguments, last.id);
              }
            }
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            lastStopReason = event.message.stopReason;
            for (const block of event.message.content) {
              if (block.type === "text") {
                response = block.text;
              }
              if (block.type === "toolCall") {
                logger.toolCall(block.name, block.arguments, last.id);
              }
            }
            logger.llmResponse(config.llm.model, event.message.stopReason, event.message.usage);
            if (event.message.stopReason === "error") {
              lastErrorMessage = (event.message as any).errorMessage;
              logger.error("LLM returned error", { errorMessage: lastErrorMessage, messageId: last.id });
            }
          }
          if (event.type === "tool_execution_start") {
            logger.toolCall(event.toolName, event.args, last.id);
          }
          if (event.type === "tool_execution_end") {
            logger.toolResult(event.toolName, event.result, event.isError, last.id);
          }
          if (event.type === "agent_end") {
            logger.agentEnd(last.id, event.messages.length);
          }
        }

        if (response) {
          // Strip markdown for iMessage compatibility
          const cleanResponse = stripMarkdown(response);
          logger.outgoing(chatId, cleanResponse);
          await sendPaced(
            {
              send: (t) => space!.send(text(t)),
              startTyping: () => space!.startTyping(),
              stopTyping: () => space!.stopTyping(),
            },
            splitResponse(cleanResponse),
          );
        } else if (lastStopReason === "error") {
          logger.warn("LLM error — notifying user", { messageId: last.id });
          await space?.send(
            text(
              lastErrorMessage?.startsWith("All providers failed")
                ? "Both my AI providers returned errors, so I can't respond right now. Try again in a bit."
                : "My AI provider returned an error. Try again in a moment.",
            ),
          );
        } else {
          logger.warn("No response generated", { messageId: last.id });
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error("Error processing message", {
          messageId: last.id,
          error: errorMsg,
          stack: error instanceof Error ? error.stack : undefined,
        });
        await space?.send(text(`Error: ${errorMsg}`));
      }
    });

    agentBusy = false;
    if (pendingMessages.length > 0) {
      logger.info("AGENT_BUSY_FLUSH", { pendingCount: pendingMessages.length, pendingChatId });
      await flushPending();
    }
  }

  const debounce = new DebounceQueue(async (chatId, messages) => {
    if (agentBusy) {
      logger.info("AGENT_BUSY_QUEUE", { chatId, count: messages.length });
      pendingMessages.push(...messages);
      pendingChatId = chatId;
      return;
    }
    processMessages(chatId, messages);
  }, 3000); // 3 second debounce window

  const seenMessageIds = new Set<string>();
  const MAX_SEEN_MESSAGE_IDS = 500;

  for await (const [space, message] of app.messages) {
    logger.info("RAW_MESSAGE_RECEIVED", { messageId: message.id, platform: message.platform, sender: message.sender?.id, contentPreview: String((message.content as any)?.text ?? (message.content as any)?.type ?? "?").substring(0, 60) });

    if (seenMessageIds.has(message.id)) {
      logger.info("DEDUP_HIT — skipping duplicate", { messageId: message.id, setBeforeDedup: seenMessageIds.size });
      continue;
    }

    logger.info("DEDUP_MISS — processing new message", { messageId: message.id, setBeforeAdd: seenMessageIds.size });
    seenMessageIds.add(message.id);
    if (seenMessageIds.size > MAX_SEEN_MESSAGE_IDS) {
      const oldest = seenMessageIds.values().next().value;
      if (oldest !== undefined) seenMessageIds.delete(oldest);
    }

    const content = message.content as any;

    // Debug: dump content structure
    logger.debug("Content part", {
      messageId: message.id,
      type: content.type,
      mimeType: content.mimeType,
      hasRead: typeof content.read === "function",
      keys: Object.keys(content),
    });

    // Extract text and media attachments from content
    let messageText = "";
    const attachments: MessageAttachment[] = [];

    if (content.type === "text") {
      messageText = content.text ?? "";
    } else if (content.type === "voice") {
      // Voice memo from Spectrum SDK (some providers deliver this type)
      if (typeof content.read === "function") {
        try {
          const buffer: Buffer = await readWithRetry(() => content.read());
          attachments.push({ mimeType: content.mimeType ?? "audio/m4a", data: buffer.toString("base64"), kind: "audio" });
          logger.debug("Read voice memo", { name: content.name, mimeType: content.mimeType, size: buffer.length, duration: content.duration });
        } catch (err) {
          logger.warn("Failed to read voice memo", { name: content.name, error: String(err) });
          try { await space?.send(text("Couldn't read your voice memo, try again.")); } catch {}
        }
      }
    } else if (content.type === "attachment" && content.mimeType?.startsWith("image/")) {
      // Single image attachment
      if (typeof content.read === "function") {
        try {
          let buffer: Buffer = await content.read();
          let mimeType = content.mimeType;
          if (isHeic(content.mimeType, content.name)) {
            logger.debug("Converting HEIC to PNG", { name: content.name, size: buffer.length });
            buffer = await convertHeicToPng(buffer);
            mimeType = "image/png";
          }
          attachments.push({ mimeType, data: buffer.toString("base64"), kind: "image" });
          logger.debug("Read image attachment", { name: content.name, mimeType, size: buffer.length });
        } catch (err) {
          logger.warn("Failed to read attachment", { name: content.name, error: String(err) });
        }
      }
    } else if (content.type === "attachment" && isAudioAttachment(content.name, content.mimeType)) {
      // Audio attachment (iMessage voice memos arrive as application/octet-stream with .caf name)
      if (typeof content.read === "function") {
        try {
          const raw: Buffer = await readWithRetry(() => content.read());
          const ext = content.name?.split(".").pop()?.toLowerCase() ?? "";
          let wavBuffer: Buffer;
          if (ext === "caf" || content.mimeType === "application/octet-stream") {
            logger.debug("Converting CAF to WAV", { name: content.name, size: raw.length });
            wavBuffer = await convertCafToWav(raw);
          } else {
            wavBuffer = raw;
          }
          attachments.push({ mimeType: "audio/wav", data: wavBuffer.toString("base64"), kind: "audio" });
          logger.debug("Read audio attachment", { name: content.name, mimeType: content.mimeType, size: raw.length, wavSize: wavBuffer.length });
        } catch (err) {
          logger.warn("Failed to read audio attachment", { name: content.name, error: String(err) });
          try { await space?.send(text("Couldn't read your voice memo, try again.")); } catch {}
        }
      }
    } else if (content.type === "attachment" && isVideoAttachment(content.name, content.mimeType)) {
      // Video attachment
      if (typeof content.read === "function") {
        try {
          const raw: Buffer = await readWithRetry(() => content.read());
          const alreadyMp4 = (content.mimeType === "video/mp4" || content.name?.toLowerCase().endsWith(".mp4"));
          const mp4Buffer = alreadyMp4 ? raw : await convertVideoToMp4(raw, content.mimeType);
          attachments.push({ mimeType: "video/mp4", data: mp4Buffer.toString("base64"), kind: "video" });
          logger.debug("Read video attachment", { name: content.name, mimeType: content.mimeType, size: raw.length, mp4Size: mp4Buffer.length, converted: !alreadyMp4 });
        } catch (err) {
          logger.warn("Failed to read video attachment", { name: content.name, error: String(err) });
          try { await space?.send(text("Couldn't read your video, try again.")); } catch {}
        }
      }
    } else if (content.type === "attachment" && isDocumentAttachment(content.name, content.mimeType)) {
      // Document attachment (PDF, text files, etc.)
      if (typeof content.read === "function") {
        try {
          const buffer: Buffer = await readWithRetry(() => content.read());
          const ext = content.name?.split(".").pop()?.toLowerCase() ?? "";
          if (ext === "pdf" || content.mimeType === "application/pdf") {
            const images = await convertPdfToImages(buffer);
            for (const img of images) {
              attachments.push({ mimeType: img.mimeType, data: img.data, kind: "image" });
            }
            logger.debug("Converted PDF to images", { name: content.name, pages: images.length });
          } else {
            const text = buffer.toString("utf-8");
            messageText += (messageText ? "\n\n" : "") + `[Document: ${content.name ?? "file"}]\n${text}`;
            attachments.push({ mimeType: content.mimeType ?? "text/plain", data: buffer.toString("base64"), kind: "document", name: content.name });
            logger.debug("Read text document", { name: content.name, mimeType: content.mimeType, size: buffer.length });
          }
        } catch (err) {
          logger.warn("Failed to read document attachment", { name: content.name, error: String(err) });
          try { await space?.send(text("Couldn't read your document, try again.")); } catch {}
        }
      }
    } else if (content.type === "group" && Array.isArray(content.items)) {
      // Group: items are Message objects with .content field
      for (const item of content.items) {
        const c = item.content;
        if (c?.type === "text") {
          messageText += (messageText ? "\n" : "") + (c.text ?? "");
        } else if (c?.type === "voice") {
          if (typeof c.read === "function") {
            try {
              const buffer: Buffer = await readWithRetry(() => c.read());
              attachments.push({ mimeType: c.mimeType ?? "audio/m4a", data: buffer.toString("base64"), kind: "audio" });
              logger.debug("Read group voice memo", { name: c.name, mimeType: c.mimeType, size: buffer.length });
            } catch (err) {
              logger.warn("Failed to read group voice memo", { name: c.name, error: String(err) });
              try { await space?.send(text("Couldn't read your voice memo, try again.")); } catch {}
            }
          }
        } else if (c?.type === "attachment" && c.mimeType?.startsWith("image/")) {
          if (typeof c.read === "function") {
            try {
              let buffer: Buffer = await c.read();
              let mimeType = c.mimeType;
              if (isHeic(c.mimeType, c.name)) {
                logger.debug("Converting group HEIC to PNG", { name: c.name, size: buffer.length });
                buffer = await convertHeicToPng(buffer);
                mimeType = "image/png";
              }
              attachments.push({ mimeType, data: buffer.toString("base64"), kind: "image" });
              logger.debug("Read group image", { name: c.name, mimeType, size: buffer.length });
            } catch (err) {
              logger.warn("Failed to read group attachment", { name: c.name, error: String(err) });
            }
          }
        } else if (c?.type === "attachment" && isAudioAttachment(c.name, c.mimeType)) {
          if (typeof c.read === "function") {
            try {
              const raw: Buffer = await readWithRetry(() => c.read());
              const ext = c.name?.split(".").pop()?.toLowerCase() ?? "";
              let wavBuffer: Buffer;
              if (ext === "caf" || c.mimeType === "application/octet-stream") {
                logger.debug("Converting group CAF to WAV", { name: c.name, size: raw.length });
                wavBuffer = await convertCafToWav(raw);
              } else {
                wavBuffer = raw;
              }
              attachments.push({ mimeType: "audio/wav", data: wavBuffer.toString("base64"), kind: "audio" });
              logger.debug("Read group audio", { name: c.name, mimeType: c.mimeType, size: raw.length });
            } catch (err) {
              logger.warn("Failed to read group audio", { name: c.name, error: String(err) });
              try { await space?.send(text("Couldn't read your voice memo, try again.")); } catch {}
            }
          }
        } else if (c?.type === "attachment" && isVideoAttachment(c.name, c.mimeType)) {
          if (typeof c.read === "function") {
            try {
              const raw: Buffer = await readWithRetry(() => c.read());
              const alreadyMp4 = (c.mimeType === "video/mp4" || c.name?.toLowerCase().endsWith(".mp4"));
              const mp4Buffer = alreadyMp4 ? raw : await convertVideoToMp4(raw, c.mimeType);
              attachments.push({ mimeType: "video/mp4", data: mp4Buffer.toString("base64"), kind: "video" });
              logger.debug("Read group video", { name: c.name, mimeType: c.mimeType, size: raw.length, mp4Size: mp4Buffer.length, converted: !alreadyMp4 });
            } catch (err) {
              logger.warn("Failed to read group video", { name: c.name, error: String(err) });
              try { await space?.send(text("Couldn't read your video, try again.")); } catch {}
            }
          }
        } else if (c?.type === "attachment" && isDocumentAttachment(c.name, c.mimeType)) {
          if (typeof c.read === "function") {
            try {
              const buffer: Buffer = await readWithRetry(() => c.read());
              const ext = c.name?.split(".").pop()?.toLowerCase() ?? "";
              if (ext === "pdf" || c.mimeType === "application/pdf") {
                const images = await convertPdfToImages(buffer);
                for (const img of images) {
                  attachments.push({ mimeType: img.mimeType, data: img.data, kind: "image" });
                }
                logger.debug("Converted group PDF to images", { name: c.name, pages: images.length });
              } else {
                const fileText = buffer.toString("utf-8");
                messageText += (messageText ? "\n\n" : "") + `[Document: ${c.name ?? "file"}]\n${fileText}`;
                attachments.push({ mimeType: c.mimeType ?? "text/plain", data: buffer.toString("base64"), kind: "document", name: c.name });
                logger.debug("Read group text document", { name: c.name, mimeType: c.mimeType, size: buffer.length });
              }
            } catch (err) {
              logger.warn("Failed to read group document", { name: c.name, error: String(err) });
              try { await space?.send(text("Couldn't read your document, try again.")); } catch {}
            }
          }
        }
      }
    }

    // Skip if no text and no attachments
    if (!messageText && attachments.length === 0) {
      logger.debug("Skipping non-text/non-image message", { messageId: message.id, platform: message.platform, type: content.type });
      continue;
    }
    if (!message.sender || message.sender.id === "agent") {
      logger.debug("Skipping agent message", { messageId: message.id });
      continue;
    }

    // Enqueue into debounce queue instead of processing immediately.
    // Key by the conversation (space.id), not platform - otherwise bursts
    // from different chats on the same platform would get merged together.
    logger.info("DEBOUNCE_PUSH", { messageId: message.id, spaceId: space.id, text: messageText.substring(0, 60) });
    debounce.push(space.id, {
      id: message.id,
      text: messageText,
      sender: message.sender?.id ?? "unknown",
      platform: message.platform,
      timestamp: new Date(),
      space,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
  }
}

async function main() {
  const config = loadConfig();

  if (config.llm.provider === "anthropic") {
    logger.info("Initializing Anthropic OAuth (shared with pi harness)...");
    await initAnthropicAuth();
  } else {
    // Best-effort: anthropic acts as the fallback provider when xiaomi errors.
    try {
      await initAnthropicAuth();
    } catch (e) {
      logger.warn("Anthropic OAuth unavailable — no fallback provider", { error: String(e) });
    }
  }
  if (!config.media.enabled && config.llm.provider === "anthropic") {
    logger.warn("Media sidecar disabled (no LLM_BASE_URL/LLM_API_KEY) - audio/video will degrade to a text note");
  }

  logger.info("Initializing memory system...");
  await initMemory();
  logger.info("Loading embedding model (first run downloads ~670MB)...");
  await ensureModelReady();
  logger.info("Memory system ready");

  loadSoul();
  logger.info("Soul loaded", { hasSoul: getSoul() !== null });

  if (config.mode === "terminal") {
    await runTerminal(config);
  } else {
    await runSpectrum(config);
  }
}

process.on("SIGINT", () => {
  logger.info("SIGINT received, shutting down");
  process.exit(0);
});

process.on("SIGTERM", () => {
  logger.info("SIGTERM received, shutting down");
  process.exit(0);
});

main().catch((error) => {
  console.error("Full error:", error);
  logger.error("Fatal error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    cause: error instanceof Error && error.cause ? String(error.cause) : undefined,
  });
  process.exit(1);
});
