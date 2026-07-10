import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { loadConfig } from "./config.ts";
import { createAgentRunner } from "./agent.ts";
import { logger } from "./logger.ts";

async function main() {
  const config = loadConfig();
  const agent = createAgentRunner(config);

  logger.info("Starting pi-spectrum iMessage agent", {
    model: config.llm.model,
    workingDirectory: config.workingDirectory,
    projectId: config.spectrum.projectId,
  });

  const app = await Spectrum({
    projectId: config.spectrum.projectId,
    projectSecret: config.spectrum.projectSecret,
    providers: [
      imessage.config(),
      terminal.config(),
    ],
  });

  logger.info("Connected to Spectrum. Listening for messages...");

  for await (const [space, message] of app.messages) {
    const textContent = message.content.find((c) => c.type === "plain_text");
    if (!textContent || textContent.type !== "plain_text") {
      logger.debug("Skipping non-text message", { messageId: message.id, platform: message.platform });
      continue;
    }
    if (message.sender.id === "agent") {
      logger.debug("Skipping agent message", { messageId: message.id });
      continue;
    }

    const msgText = textContent.text;
    logger.incoming(message.platform, message.sender.id, msgText, message.id);

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
        let messageCount = 0;

        for await (const event of agent.prompt(msgText)) {
          logger.raw({ event: event.type, messageId: message.id });

          if (event.type === "agent_start") {
            logger.agentStart(message.id);
          }

          if (event.type === "turn_start") {
            logger.turnStart(message.id);
          }

          if (event.type === "message_start" && event.message.role === "assistant") {
            logger.debug("Assistant message started", { messageId: message.id });
          }

          if (event.type === "message_update" && event.message.role === "assistant") {
            const content = event.message.content;
            for (const block of content) {
              if (block.type === "text") {
                response = block.text;
              }
              if (block.type === "toolCall") {
                logger.toolCall(block.name, block.arguments, message.id);
              }
            }
          }

          if (event.type === "message_end" && event.message.role === "assistant") {
            const content = event.message.content;
            for (const block of content) {
              if (block.type === "text") {
                response += block.text;
              }
              if (block.type === "toolCall") {
                logger.toolCall(block.name, block.arguments, message.id);
              }
            }
            messageCount++;
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
      const errorStack = error instanceof Error ? error.stack : undefined;
      logger.error("Error processing message", {
        messageId: message.id,
        error: errorMsg,
        stack: errorStack,
      });
      await space.send(text(`Error: ${errorMsg}`));
    }
  }
}

main().catch((error) => {
  logger.error("Fatal error", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
