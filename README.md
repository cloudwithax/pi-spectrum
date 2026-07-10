# pi-spectrum

Pi coding agent harness + Spectrum iMessage provider = ultimate iMessage coding agent.

Text your codebase from iMessage. Get AI-powered coding assistance, file operations, and terminal access through the world's most popular messaging app.

## What is this?

This combines two powerful tools:

- **[Pi](https://github.com/earendil-works/pi)** - AI agent toolkit with unified LLM API, agent loop, and tool calling
- **[Spectrum](https://photon.codes)** - Universal messaging SDK that connects agents to iMessage, WhatsApp, Telegram, and more

The result: an AI coding assistant you can text from iMessage.

## Features

- Read, write, and edit files via iMessage
- Run bash commands remotely
- Explore codebases conversationally
- Powered by MiMo-V2.5 (or any compatible model)
- Supports both iMessage and terminal providers

## Setup

1. Clone the repo:
   ```bash
   git clone https://github.com/cloudwithax/pi-spectrum
   cd pi-spectrum
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

4. Build and run:
   ```bash
   npm run build
   npm start
   ```

   Or for development:
   ```bash
   npm run dev
   ```

## Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SPECTRUM_PROJECT_ID` | Yes | Your Spectrum project ID |
| `SPECTRUM_PROJECT_SECRET` | Yes | Your Spectrum project secret |
| `SPECTRUM_WEBHOOK_SECRET` | No | Webhook signing secret |
| `LLM_BASE_URL` | Yes | LLM API endpoint |
| `LLM_API_KEY` | Yes | LLM API key |
| `LLM_MODEL` | No | Model ID (default: mimo-v2.5) |
| `WORKING_DIRECTORY` | No | Working directory for file operations |

## Commands

Text these commands in iMessage:

- `/quit` - Shut down the agent
- `/clear` - Clear conversation history

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  iMessage   │────▶│   Spectrum   │────▶│  pi-spectrum │
│  (user)     │◀────│   Provider   │◀────│   Agent      │
└─────────────┘     └──────────────┘     └──────┬──────┘
                                                │
                                         ┌──────▼──────┐
                                         │  Pi Agent   │
                                         │  Loop +     │
                                         │  Tools      │
                                         └──────┬──────┘
                                                │
                                         ┌──────▼──────┐
                                         │  MiMo-V2.5  │
                                         │  (LLM)      │
                                         └─────────────┘
```

## License

MIT
