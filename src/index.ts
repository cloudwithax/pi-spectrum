import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { loadConfig } from "./config.ts";
import { createAgentRunner } from "./agent.ts";
import { logger } from "./logger.ts";
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

    const msgText = textContent.text;
    const senderId = message.sender?.id ?? "unknown";
    logger.incoming(message.platform, senderId, msgText, message.id);

    if (msgText.toLowerCase() === "/quit" || msgText.toLowerCase() === "/exit") {
      logger.info("Shutdown requested");
      agent.stop();
      await app.stop();
      process.exit(0);
    }

    if (msgText.toLowerCase() === "/clear") {
      logger.info("Clear command received", { spaceId: space.id });
      await space.send(text("Conversation cleared."));
      continue;
    }

    try {
      await space.responding(async () => {
        let response = "";

        for await (const event of agent.prompt(msgText)) {
          if (event.type === "agent_start") {
            logger.agentStart(message.id);
          }
          if (event.type === "turn_start") {
            logger.turnStart(message.id);
          }
          if (event.type === "message_update" && event.message.role === "assistant") {
            for (const block of event.message.content) {
              if (block.type === "toolCall") {
                logger.toolCall(block.name, block.arguments, message.id);
              }
            }
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            for (const block of event.message.content) {
              if (block.type === "text") {
                response = block.text;
              }
              if (block.type === "toolCall") {
                logger.toolCall(block.name, block.arguments, message.id);
              }
            }
            logger.llmResponse(config.llm.model, event.message.stopReason, event.message.usage);
          }
          if (event.type === "tool_execution_start") {
            logger.toolCall(event.toolName, event.args, message.id);
          }
          if (event.type === "tool_execution_end") {
            logger.toolResult(event.toolName, event.result, event.isError, message.id);
          }
          if (event.type === "agent_end") {
            logger.agentEnd(message.id, event.messages.length);
          }
        }

        if (response) {
          logger.outgoing(space.id, response);
          await space.send(text(response));
        } else {
          logger.warn("No response generated", { messageId: message.id });
        }
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error("Error processing message", {
        messageId: message.id,
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined,
      });
      await space.send(text(`Error: ${errorMsg}`));
    }
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
