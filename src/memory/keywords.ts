import { getDb, type StoredMessage } from "./db.ts";
import { logger } from "../logger.ts";

// Keyword graph: core keywords extracted from every message, linked by
// co-occurrence. Recall walks direct keyword hits plus one tangential hop
// through the strongest links, then surfaces the verbatim messages behind
// them as passive "you remember" context.

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "her", "was", "one", "our",
  "out", "day", "get", "has", "him", "his", "how", "man", "new", "now", "old", "see", "two", "way",
  "who", "did", "its", "let", "put", "say", "she", "too", "use", "that", "this", "with", "have",
  "from", "they", "will", "would", "there", "their", "what", "about", "which", "when", "make",
  "like", "time", "just", "know", "take", "into", "your", "some", "them", "than", "then", "look",
  "only", "come", "over", "think", "also", "back", "after", "work", "well", "even", "want",
  "because", "these", "give", "most", "yeah", "okay", "lol", "gonna", "wanna", "really", "thing",
  "things", "stuff", "been", "being", "were", "dont", "cant", "didnt", "thats", "youre", "here",
  "still", "much", "very", "should", "could", "going", "right", "good", "need", "kinda", "sorta",
  "actually", "basically", "literally", "probably", "maybe", "something", "anything", "nothing",
  "everything", "someone", "anyone", "everyone", "little", "sure", "does", "doing", "done", "got",
  "had", "made", "many", "more", "other", "such", "where", "while", "before", "between", "both",
  "each", "under", "again", "same", "though", "through", "down", "off", "own", "why", "yes", "no",
]);

/** Pull core keywords out of a message: lowercase words, stopwords stripped. */
export function extractKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9']+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/'/g, ""))
    .filter((w) => w.length >= 3 && w.length <= 30 && !STOPWORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}

export function initKeywordSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      word TEXT NOT NULL UNIQUE,
      message_count INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS message_keywords (
      message_id TEXT NOT NULL,
      keyword_id INTEGER NOT NULL,
      PRIMARY KEY (message_id, keyword_id),
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (keyword_id) REFERENCES keywords(id)
    );

    CREATE TABLE IF NOT EXISTS keyword_links (
      keyword_a_id INTEGER NOT NULL,
      keyword_b_id INTEGER NOT NULL,
      weight REAL DEFAULT 1.0,
      PRIMARY KEY (keyword_a_id, keyword_b_id),
      FOREIGN KEY (keyword_a_id) REFERENCES keywords(id),
      FOREIGN KEY (keyword_b_id) REFERENCES keywords(id)
    );

    CREATE INDEX IF NOT EXISTS idx_message_keywords_keyword ON message_keywords(keyword_id);
    CREATE INDEX IF NOT EXISTS idx_keyword_links_a ON keyword_links(keyword_a_id);
  `);
}

/** Index a message's keywords into the graph and strengthen co-occurrence links. */
export function indexMessageKeywords(messageId: string, text: string): void {
  const db = getDb();
  const words = extractKeywords(text).slice(0, 24);
  if (words.length === 0) return;

  const ids: number[] = [];
  const upsert = db.prepare(
    "INSERT INTO keywords (word, message_count) VALUES (?, 1) ON CONFLICT(word) DO UPDATE SET message_count = message_count + 1 RETURNING id",
  );
  const link = db.prepare(
    "INSERT OR IGNORE INTO message_keywords (message_id, keyword_id) VALUES (?, ?)",
  );
  for (const word of words) {
    const row = upsert.get(word) as { id: number };
    ids.push(row.id);
    link.run(messageId, row.id);
  }

  const bump = db.prepare(
    "INSERT INTO keyword_links (keyword_a_id, keyword_b_id, weight) VALUES (?, ?, 1.0) ON CONFLICT(keyword_a_id, keyword_b_id) DO UPDATE SET weight = weight + 1.0",
  );
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = ids[i] < ids[j] ? [ids[i], ids[j]] : [ids[j], ids[i]];
      bump.run(a, b);
    }
  }
}

/** One-time backfill: index every stored message that has no keywords yet. */
export function backfillKeywords(): void {
  const db = getDb();
  const pending = db
    .prepare(
      "SELECT id, text FROM messages WHERE id NOT IN (SELECT DISTINCT message_id FROM message_keywords) ORDER BY timestamp",
    )
    .all() as Array<{ id: string; text: string }>;
  if (pending.length === 0) return;
  logger.info("Backfilling keyword graph", { messages: pending.length });
  db.exec("BEGIN");
  try {
    for (const m of pending) indexMessageKeywords(m.id, m.text);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  logger.info("Keyword graph backfill complete");
}

export interface RecalledMemory {
  message: StoredMessage;
  /** Keywords that connected this memory to the current message. */
  via: string[];
  score: number;
}

/**
 * Walk the keyword graph from the current message: direct keyword hits score
 * highest, then one tangential hop through the strongest co-occurrence links.
 * Rare keywords weigh more than common ones (idf-style).
 */
export function recallByKeywords(text: string, limit = 6, excludeSinceTs = 0): RecalledMemory[] {
  const db = getDb();
  const words = extractKeywords(text);
  if (words.length === 0) return [];

  const totalMessages = (db.prepare("SELECT COUNT(*) AS c FROM messages").get() as any).c as number;
  if (totalMessages === 0) return [];

  // Direct keywords from the message.
  const kwStmt = db.prepare("SELECT id, word, message_count FROM keywords WHERE word = ?");
  const seeds = new Map<number, { word: string; weight: number; count: number }>();
  for (const w of words) {
    const row = kwStmt.get(w) as { id: number; word: string; message_count: number } | undefined;
    if (!row) continue;
    // Skip near-ubiquitous words; weight rare ones higher.
    if (row.message_count > totalMessages * 0.2) continue;
    seeds.set(row.id, { word: row.word, weight: Math.log(totalMessages / (1 + row.message_count)), count: row.message_count });
  }
  if (seeds.size === 0) return [];

  // Tangential hop: strongest co-occurring neighbors of the seed keywords.
  const active = new Map(seeds);
  const hopStmt = db.prepare(`
    SELECT k.id, k.word, k.message_count, l.weight AS link_weight
    FROM keyword_links l
    JOIN keywords k ON k.id = CASE WHEN l.keyword_a_id = ? THEN l.keyword_b_id ELSE l.keyword_a_id END
    WHERE l.keyword_a_id = ? OR l.keyword_b_id = ?
    ORDER BY l.weight DESC LIMIT 5
  `);
  for (const [id, seed] of seeds) {
    const neighbors = hopStmt.all(id, id, id) as Array<{ id: number; word: string; message_count: number; link_weight: number }>;
    for (const n of neighbors) {
      if (active.has(n.id) || n.message_count > totalMessages * 0.2) continue;
      // Tangential matches carry a fraction of the seed's weight.
      active.set(n.id, { word: n.word, weight: seed.weight * 0.35, count: n.message_count });
    }
  }

  // Score messages by the summed weight of the keywords they share.
  const msgStmt = db.prepare("SELECT message_id FROM message_keywords WHERE keyword_id = ?");
  const scores = new Map<string, { score: number; via: Set<string> }>();
  for (const [id, kw] of active) {
    const rows = msgStmt.all(id) as Array<{ message_id: string }>;
    for (const r of rows) {
      const entry = scores.get(r.message_id) ?? { score: 0, via: new Set<string>() };
      entry.score += kw.weight;
      entry.via.add(kw.word);
      scores.set(r.message_id, entry);
    }
  }

  const getMsg = db.prepare("SELECT id, timestamp, sender, role, text FROM messages WHERE id = ?");
  const out: RecalledMemory[] = [];
  const seenTexts = new Set<string>();
  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  for (const [messageId, entry] of ranked) {
    if (entry.via.size < 2) continue; // one shared word is noise
    const msg = getMsg.get(messageId) as StoredMessage | undefined;
    if (!msg) continue;
    if (excludeSinceTs && msg.timestamp >= excludeSinceTs) continue; // skip the live conversation
    const textKey = msg.text.trim().toLowerCase().slice(0, 200);
    if (seenTexts.has(textKey)) continue; // duplicate stored messages
    seenTexts.add(textKey);
    out.push({ message: msg, via: [...entry.via], score: entry.score });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Build the passive recall block injected into the system prompt: short
 * "you remember" hints with dates, pointing at the verbatim library for depth.
 */
export function buildRecallBlock(text: string, excludeSinceTs = 0): string {
  let memories: RecalledMemory[];
  try {
    memories = recallByKeywords(text, 6, excludeSinceTs);
  } catch (e) {
    logger.warn("Keyword recall failed", { error: String(e) });
    return "";
  }
  if (memories.length === 0) return "";

  const lines = memories.map((m) => {
    const date = new Date(m.message.timestamp).toISOString().slice(0, 10);
    const who = m.message.role === "user" ? "the user said" : "you said";
    return `- [${date}, via: ${m.via.slice(0, 4).join(", ")}] ${who}: "${m.message.text.slice(0, 200)}"`;
  });

  return `PASSIVE RECALL (auto-surfaced from your keyword memory graph based on the current message - may be tangential or irrelevant, use judgment):
${lines.join("\n")}
Every message ever exchanged is stored verbatim. If any of these seem relevant, optionally fetch the full context with getChatHistory (keyword/time filters) or recallMemory (semantic search) before answering.`;
}
