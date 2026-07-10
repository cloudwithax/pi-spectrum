import { Spectrum, text } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { terminal } from "spectrum-ts/providers/terminal";
import { loadConfig } from "./config.ts";
import { createAgentRunner } from "./agent.ts";

async function main() {
  const config = loadConfig();
  const agent = createAgentRunner(config);

  console.log("Starting pi-spectrum iMessage agent...");
  console.log(`Model: ${config.llm.model}`);
  console.log(`Working directory: ${config.workingDirectory}`);

  const app = await Spectrum({
    projectId: config.spectrum.projectId,
    projectSecret: config.spectrum.projectSecret,
    providers: [
      imessage.config(),
      terminal.config(),
    ],
  });

  console.log("Connected to Spectrum. Listening for messages...");

  for await (const [space, message] of app.messages) {
    const textContent = message.content.find((c) => c.type === "plain_text");
    if (!textContent || textContent.type !== "plain_text") continue;
    if (message.sender.id === "agent") continue;

    const msgText = textContent.text;
    console.log(`[${message.platform}] ${message.sender.id}: ${msgText}`);

    if (msgText.toLowerCase() === "/quit" || msgText.toLowerCase() === "/exit") {
      console.log("Shutting down...");
      agent.stop();
      await app.stop();
      process.exit(0);
    }

    if (msgText.toLowerCase() === "/clear") {
      await space.send(text("Conversation cleared."));
      continue;
    }

    try {
      await space.responding(async () => {
        let response = "";
        for await (const event of agent.prompt(msgText)) {
          if (event.type === "message_update" && event.message.role === "assistant") {
            const content = event.message.content;
            for (const block of content) {
              if (block.type === "text") {
                response = block.text;
              }
            }
          }
          if (event.type === "message_end" && event.message.role === "assistant") {
            const content = event.message.content;
            for (const block of content) {
              if (block.type === "text") {
                response += block.text;
              }
            }
          }
        }
        if (response) {
          await space.send(text(response));
        }
      });
    } catch (error) {
      console.error("Error processing message:", error);
      await space.send(text(`Error: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
