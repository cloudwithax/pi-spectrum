import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { loadConfig } from "./config.ts";
import { createAgentRunner } from "./agent.ts";
import { logger } from "./logger.ts";
import { stripMarkdown, splitResponse, DebounceQueue, sendPaced } from "./imessage-utils.ts";
import * as readline from "node:readline";

async function runTerminal(config: ReturnType<typeof loadConfig>) {
  const agent = createAgentRunner(config);

  logger.info("Starting pi-spectrum in TERMINAL mode", {
    model: config.llm.model,
    workingDirectory: config.workingDirectory,
  });
  console.log("pi-spectrum terminal mode. Type messages, Ctrl+C to exit.\n");

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
        rl.close();
        process.exit(0);
      }

      logger.incoming("terminal", "user", msgText, Date.now().toString());

      try {
        let response = "";
        for await (const event of agent.prompt(msgText)) {
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
            for (const block of event.message.content) {
              if (block.type === "text") {
                response = block.text;
              }
              if (block.type === "toolCall") {
                logger.toolCall(block.name, block.arguments, msgText);
              }
            }
            logger.llmResponse(config.llm.model, event.message.stopReason, event.message.usage);
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

  const debounce = new DebounceQueue(async (chatId, messages) => {
    // Use the last message's context for the response
    const last = messages[messages.length - 1];
    const space = last.space;

    logger.info("Debounce flush", { chatId, count: messages.length });

    await space?.responding(async () => {
      // If multiple messages accumulated, treat earlier ones as context
      let userText = messages.map((m) => m.text).join("\n");

      // Only log individual incoming for each message
      for (const m of messages) {
        logger.incoming(m.platform, m.sender, m.text, m.id);
      }

      // Handle commands from any message in the batch
      for (const m of messages) {
        if (m.text.toLowerCase() === "/quit" || m.text.toLowerCase() === "/exit") {
          logger.info("Shutdown requested");
          agent.stop();
          await app.stop();
          process.exit(0);
        }
        if (m.text.toLowerCase() === "/clear") {
          logger.info("Clear command received", { spaceId: chatId });
          await space?.send(text("Conversation cleared."));
          return;
        }
      }

      try {
        let response = "";

        for await (const event of agent.prompt(userText)) {
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
            for (const block of event.message.content) {
              if (block.type === "text") {
                response = block.text;
              }
              if (block.type === "toolCall") {
                logger.toolCall(block.name, block.arguments, last.id);
              }
            }
            logger.llmResponse(config.llm.model, event.message.stopReason, event.message.usage);
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
            (t) => space!.send(text(t)),
            splitResponse(cleanResponse),
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
  }, 3000); // 3 second debounce window

  for await (const [space, message] of app.messages) {
    logger.raw({ event: "raw_message", messageId: message.id, content: message.content, sender: message.sender });

    const content = message.content as any;
    const textContent = Array.isArray(content)
      ? content.find((c: any) => c.type === "text" || c.type === "plain_text")
      : content?.type === "text" || content?.type === "plain_text"
        ? content
        : null;

    if (!textContent) {
      logger.debug("Skipping non-text message", { messageId: message.id, platform: message.platform });
      continue;
    }
    if (!message.sender || message.sender.id === "agent") {
      logger.debug("Skipping agent message", { messageId: message.id });
      continue;
    }

    // Enqueue into debounce queue instead of processing immediately
    debounce.push(message.platform, {
      id: message.id,
      text: textContent.text,
      sender: message.sender?.id ?? "unknown",
      platform: message.platform,
      timestamp: new Date(),
      space,
    });
  }
}

async function main() {
  const config = loadConfig();

  if (config.mode === "terminal") {
    await runTerminal(config);
  } else {
    await runSpectrum(config);
  }
}

main().catch((error) => {
  console.error("Full error:", error);
  logger.error("Fatal error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    cause: error instanceof Error && error.cause ? String(error.cause) : undefined,
  });
  process.exit(1);
});
