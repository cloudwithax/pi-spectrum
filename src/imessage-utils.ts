/**
 * Strip markdown formatting for iMessage compatibility.
 * iMessage renders plain text only - no bold, headers, code blocks, etc.
 */
export function stripMarkdown(text: string): string {
  return text
    // Headers
    .replace(/^#{1,6}\s+/gm, "")
    // Bold/italic
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/___(.+?)___/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/_(.+?)_/g, "$1")
    // Strikethrough
    .replace(/~~(.+?)~~/g, "$1")
    // Code blocks - extract content
    .replace(/```[\s\S]*?\n([\s\S]*?)```/g, "$1")
    // Inline code
    .replace(/`([^`]+)`/g, "$1")
    // Links - show text only
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    // Images - show alt text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "[$1]")
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, "")
    // Blockquotes
    .replace(/^>\s+/gm, "")
    // Unordered list markers
    .replace(/^[\s]*[-*+]\s+/gm, "• ")
    // Ordered list markers
    .replace(/^[\s]*\d+\.\s+/gm, "• ")
    // Collapse multiple newlines
    .replace(/\n{3,}/g, "\n\n")
    // Trim
    .trim();
}

/**
 * Debounced message queue per chat.
 * Collects messages during a burst and flushes after the window settles.
 */
export class DebounceQueue {
  private queues = new Map<string, { messages: QueuedMessage[]; timer: ReturnType<typeof setTimeout> | null }>();
  private onFlush: (chatId: string, messages: QueuedMessage[]) => Promise<void>;
  private windowMs: number;

  constructor(onFlush: (chatId: string, messages: QueuedMessage[]) => Promise<void>, windowMs = 3000) {
    this.onFlush = onFlush;
    this.windowMs = windowMs;
  }

  push(chatId: string, message: QueuedMessage): void {
    let queue = this.queues.get(chatId);
    if (!queue) {
      queue = { messages: [], timer: null };
      this.queues.set(chatId, queue);
    }

    queue.messages.push(message);

    // Reset the debounce timer
    if (queue.timer !== null) {
      clearTimeout(queue.timer);
    }

    queue.timer = setTimeout(() => {
      this.flush(chatId);
    }, this.windowMs);
  }

  private async flush(chatId: string): Promise<void> {
    const queue = this.queues.get(chatId);
    if (!queue || queue.messages.length === 0) return;

    // Clear state first to avoid re-entrancy
    const messages = queue.messages.splice(0);
    queue.timer = null;

    // Drain in handler, not enqueuer (per Photon pattern)
    await this.onFlush(chatId, messages);
  }

  cancel(chatId: string): void {
    const queue = this.queues.get(chatId);
    if (queue && queue.timer !== null) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }
  }

  flushSync(chatId: string): void {
    this.cancel(chatId);
    const queue = this.queues.get(chatId);
    if (queue) {
      this.flush(chatId);
    }
  }
}

export interface QueuedMessage {
  id: string;
  text: string;
  sender: string;
  platform: string;
  timestamp: Date;
  space: any; // Space reference for sending replies
}

/**
 * Send multiple messages with pacing.
 * iMessage doesn't handle rapid-fire messages well.
 */
export async function sendPaced(
  sendFn: (text: string) => Promise<void>,
  texts: string[],
  delayMs = 500,
): Promise<void> {
  for (let i = 0; i < texts.length; i++) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    await sendFn(texts[i]);
  }
}

/**
 * Split a long response into smaller chunks.
 * iMessage has a character limit and long walls of text are hard to read.
 * Splits on double newlines (paragraphs) and respects a max length.
 */
export function splitResponse(text: string, maxLen = 300): string[] {
  if (text.length <= maxLen) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > maxLen && current) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}
