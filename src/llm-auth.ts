import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getOAuthApiKey } from "@earendil-works/pi-ai/oauth";
import type { Config } from "./config.ts";
import { logger } from "./logger.ts";

// Shared credential store used by the system pi instance. We read/refresh the
// same file so pi-spectrum stays in sync with the harness's Anthropic login.
const AUTH_PATH = process.env.PI_AUTH_PATH || join(homedir(), ".pi", "agent", "auth.json");

let currentKey: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

interface AnthropicCreds {
  type?: string;
  refresh: string;
  access: string;
  expires: number;
  [k: string]: unknown;
}

function readStore(): Record<string, any> {
  return JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
}

/**
 * Load the current Anthropic OAuth key, refreshing (and persisting) if the
 * access token has expired. Always re-reads the file so we pick up the latest
 * refresh token even if the pi harness rotated it. Returns the expiry (ms).
 */
async function loadAndRefresh(): Promise<number> {
  const store = readStore();
  const creds = store.anthropic as AnthropicCreds | undefined;
  if (!creds?.access || !creds?.refresh) {
    throw new Error(`No Anthropic OAuth credentials found in ${AUTH_PATH}. Log in with the pi harness first.`);
  }

  const result = await getOAuthApiKey("anthropic", { anthropic: creds });
  if (!result) throw new Error("Failed to resolve Anthropic OAuth key");

  currentKey = result.apiKey;

  // Persist rotated credentials back to the shared store.
  if (result.newCredentials.access !== creds.access || result.newCredentials.refresh !== creds.refresh) {
    store.anthropic = { ...creds, ...result.newCredentials, type: "oauth" };
    writeFileSync(AUTH_PATH, JSON.stringify(store, null, 2));
    logger.info("Refreshed Anthropic OAuth token", { expires: new Date(result.newCredentials.expires).toISOString() });
  }

  return result.newCredentials.expires;
}

function scheduleRefresh(expires: number): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  const bufferMs = 5 * 60 * 1000;
  const delay = Math.max(60 * 1000, expires - Date.now() - bufferMs);
  refreshTimer = setTimeout(async () => {
    try {
      const next = await loadAndRefresh();
      scheduleRefresh(next);
    } catch (e) {
      logger.warn("Anthropic token refresh failed, retrying in 2m", { error: String(e) });
      scheduleRefresh(Date.now() + 2 * 60 * 1000);
    }
  }, delay);
  refreshTimer.unref?.();
}

/** Initialize Anthropic OAuth: fetch the key and schedule proactive refresh. */
export async function initAnthropicAuth(): Promise<void> {
  const expires = await loadAndRefresh();
  scheduleRefresh(expires);
  logger.info("Anthropic OAuth ready", { authPath: AUTH_PATH, expires: new Date(expires).toISOString() });
}

/** Current Anthropic OAuth access token (kept fresh by the refresh timer). */
export function getCurrentAnthropicKey(): string {
  if (!currentKey) throw new Error("Anthropic OAuth not initialized - call initAnthropicAuth() first");
  return currentKey;
}

/** Whether Anthropic OAuth has been initialized (i.e. usable as a fallback). */
export function hasAnthropicAuth(): boolean {
  return currentKey !== null;
}

/** Resolve the API key for a specific provider. */
export function getApiKeyForProvider(provider: Config["llm"]["provider"], config: Config): string {
  if (provider === "anthropic") return getCurrentAnthropicKey();
  return config.llm.apiKey;
}

/** Resolve the API key for whichever provider the config selects. */
export function getLlmApiKey(config: Config): string {
  return getApiKeyForProvider(config.llm.provider, config);
}
