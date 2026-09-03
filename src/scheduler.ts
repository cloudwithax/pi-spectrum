import { CronExpressionParser } from "cron-parser";
import { randomUUID } from "node:crypto";
import type { AgentRunner } from "./agent.ts";
import { logger } from "./logger.ts";
import {
  insertTimer,
  getTimer,
  getEnabledTimers,
  getAllTimers,
  updateTimer,
  deleteTimer,
  type StoredTimer,
} from "./memory/index.ts";

export interface SchedulerDeps {
  agentRunner: AgentRunner;
  sendMessage: (text: string) => Promise<void>;
}

export interface Scheduler {
  setTimer(schedule: string, prompt: string, silent?: boolean): { id: string; error?: string };
  setRecurringReminder(cron: string, prompt: string, silent?: boolean): { id: string; error?: string };
  cancelTimer(id: string): { success: boolean; error?: string };
  listTimers(): StoredTimer[];
  restoreTimers(): Promise<void>;
  shutdown(): void;
}

const ONE_DAY_MS = 86400_000;

function parseOneOffSchedule(schedule: string): { fireAtMs: number; error?: string } {
  const trimmed = schedule.trim();

  // Cron expression: contains spaces or @ prefix
  if (trimmed.includes(" ") || trimmed.startsWith("@")) {
    try {
      const expr = CronExpressionParser.parse(trimmed, { currentDate: new Date() });
      const next = expr.next();
      return { fireAtMs: next.getTime() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { fireAtMs: 0, error: `Invalid cron expression: ${msg}` };
    }
  }

  // Number + "d" suffix: days
  const dayMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*d$/i);
  if (dayMatch) {
    const days = parseFloat(dayMatch[1]);
    if (isNaN(days) || days <= 0) {
      return { fireAtMs: 0, error: `Invalid day value: "${dayMatch[1]}"` };
    }
    return { fireAtMs: Date.now() + days * ONE_DAY_MS };
  }

  // Pure number: seconds
  const secMatch = trimmed.match(/^(\d+(?:\.\d+)?)$/);
  if (secMatch) {
    const seconds = parseFloat(secMatch[1]);
    if (isNaN(seconds) || seconds <= 0) {
      return { fireAtMs: 0, error: `Invalid second value: "${secMatch[1]}"` };
    }
    if (seconds >= 86400) {
      return { fireAtMs: 0, error: `Value too large for seconds (${seconds}). Use days (e.g. "1d") for >= 1 day.` };
    }
    return { fireAtMs: Date.now() + seconds * 1000 };
  }

  return { fireAtMs: 0, error: `Invalid schedule format: "${schedule}". Use seconds (e.g. "300"), days (e.g. "3d"), or cron expression (e.g. "0 9 * * *").` };
}

function parseCronNextFire(cron: string, tz?: string): { nextFireMs: number; error?: string } {
  try {
    const expr = CronExpressionParser.parse(cron, { currentDate: new Date(), tz });
    const next = expr.next();
    return { nextFireMs: next.getTime() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { nextFireMs: 0, error: `Invalid cron expression: ${msg}` };
  }
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const cronIntervals = new Map<string, ReturnType<typeof setInterval>>();

  async function fireTimer(stored: StoredTimer): Promise<void> {
    logger.info("Timer firing", { id: stored.id, type: stored.type, prompt: stored.prompt, silent: stored.silent });

    updateTimer(stored.id, { lastFired: Date.now() });

    try {
      const events = deps.agentRunner.prompt(stored.prompt);
      let response = "";

      for await (const event of events) {
        if (event.type === "message_end" && event.message.role === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text") {
              response = block.text;
            }
          }
        }
      }

      if (!stored.silent && response) {
        await deps.sendMessage(response);
      }
    } catch (e) {
      logger.error("Timer fire failed", { id: stored.id, error: String(e) });
    }
  }

  function scheduleOneOff(stored: StoredTimer): void {
    if (!stored.fireAt) return;
    const delay = stored.fireAt - Date.now();
    if (delay <= 0) {
      // Already past, fire immediately
      fireTimer(stored);
      return;
    }
    const handle = setTimeout(() => {
      timers.delete(stored.id);
      fireTimer(stored);
      // For one-off timers, delete from DB after firing
      deleteTimer(stored.id);
    }, delay);
    timers.set(stored.id, handle);
  }

  function scheduleRecurring(stored: StoredTimer): void {
    if (!stored.nextFire) return;
    const delay = stored.nextFire - Date.now();
    if (delay <= 0) {
      // Fire immediately, then schedule next
      fireTimer(stored).then(() => {
        const { nextFireMs, error } = parseCronNextFire(stored.schedule);
        if (!error) {
          updateTimer(stored.id, { nextFire: nextFireMs });
          const updated = { ...stored, nextFire: nextFireMs };
          scheduleRecurring(updated);
        }
      });
      return;
    }
    const handle = setTimeout(() => {
      cronIntervals.delete(stored.id);
      fireTimer(stored).then(() => {
        // Compute next fire time
        const { nextFireMs, error } = parseCronNextFire(stored.schedule);
        if (!error) {
          updateTimer(stored.id, { nextFire: nextFireMs });
          const updated = { ...stored, nextFire: nextFireMs };
          scheduleRecurring(updated);
        } else {
          logger.error("Failed to compute next cron fire", { id: stored.id, error });
        }
      });
    }, delay);
    cronIntervals.set(stored.id, handle);
  }

  function scheduleTimer(stored: StoredTimer): void {
    if (!stored.enabled) return;
    if (stored.type === "oneoff") {
      scheduleOneOff(stored);
    } else {
      scheduleRecurring(stored);
    }
  }

  return {
    setTimer(schedule, prompt, silent = false) {
      const { fireAtMs, error } = parseOneOffSchedule(schedule);
      if (error) return { id: "", error };

      const id = randomUUID();
      const stored: StoredTimer = {
        id,
        type: "oneoff",
        schedule,
        prompt,
        silent,
        createdAt: Date.now(),
        fireAt: fireAtMs,
        nextFire: null,
        enabled: true,
        lastFired: null,
      };

      insertTimer(stored);
      scheduleTimer(stored);

      const delaySec = Math.round((fireAtMs - Date.now()) / 1000);
      logger.info("Timer created", { id, schedule, prompt: prompt.substring(0, 80), silent, fireIn: `${delaySec}s` });
      return { id };
    },

    setRecurringReminder(cron, prompt, silent = false) {
      const { nextFireMs, error } = parseCronNextFire(cron);
      if (error) return { id: "", error };

      const id = randomUUID();
      const stored: StoredTimer = {
        id,
        type: "recurring",
        schedule: cron,
        prompt,
        silent,
        createdAt: Date.now(),
        fireAt: null,
        nextFire: nextFireMs,
        enabled: true,
        lastFired: null,
      };

      insertTimer(stored);
      scheduleTimer(stored);

      logger.info("Recurring reminder created", { id, cron, prompt: prompt.substring(0, 80), silent, nextFire: new Date(nextFireMs).toISOString() });
      return { id };
    },

    cancelTimer(id) {
      const existing = getTimer(id);
      if (!existing) return { success: false, error: `Timer ${id} not found` };

      // Clear active handles
      const oneOffHandle = timers.get(id);
      if (oneOffHandle) {
        clearTimeout(oneOffHandle);
        timers.delete(id);
      }
      const recurringHandle = cronIntervals.get(id);
      if (recurringHandle) {
        clearTimeout(recurringHandle);
        cronIntervals.delete(id);
      }

      deleteTimer(id);
      logger.info("Timer cancelled", { id });
      return { success: true };
    },

    listTimers() {
      return getAllTimers();
    },

    async restoreTimers() {
      const enabled = getEnabledTimers();
      if (enabled.length === 0) {
        logger.info("No active timers to restore");
        return;
      }

      logger.info("Restoring timers", { count: enabled.length });
      for (const stored of enabled) {
        // Check if one-off timer has already passed
        if (stored.type === "oneoff" && stored.fireAt && stored.fireAt < Date.now()) {
          logger.info("One-off timer already past, firing now", { id: stored.id });
          fireTimer(stored);
          deleteTimer(stored.id);
          continue;
        }

        // For recurring, recalculate next fire if in the past
        if (stored.type === "recurring" && stored.nextFire && stored.nextFire < Date.now()) {
          const { nextFireMs, error } = parseCronNextFire(stored.schedule);
          if (!error) {
            updateTimer(stored.id, { nextFire: nextFireMs });
            stored.nextFire = nextFireMs;
          }
        }

        scheduleTimer(stored);
      }

      logger.info("Timers restored", { count: enabled.length });
    },

    shutdown() {
      for (const [, handle] of timers) clearTimeout(handle);
      for (const [, handle] of cronIntervals) clearTimeout(handle);
      timers.clear();
      cronIntervals.clear();
      logger.info("Scheduler shutdown");
    },
  };
}
