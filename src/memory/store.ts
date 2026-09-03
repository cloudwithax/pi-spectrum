import { embedText } from "./embeddings.ts";
import {
  getDb,
  insertMessage,
  updateMessageEmbedding,
  upsertEntity,
  linkMessageToEntity,
  linkEntities,
  searchMessagesByEmbedding,
  getEntityByName,
  getMessagesForEntity,
  getLinkedEntities,
  searchEntities,
  getRecentMessages,
  getTopEntities,
  getEntityRelationships,
  getMessageCount,
  getEntityCount,
  type StoredMessage,
  type StoredEntity,
} from "./db.ts";
import { logger } from "../logger.ts";

export async function initMemory(dbPath?: string): Promise<void> {
  getDb(dbPath);
  logger.info("Memory database initialized");
}

export async function ensureModelReady(): Promise<void> {
  await embedText("warmup");
}

export interface StoreMessageOptions {
  id: string;
  timestamp: number;
  sender: string;
  role: "user" | "assistant";
  text: string;
  /** Pre-extracted entities from LLM. If omitted, skipped for this message. */
  entities?: Array<{ name: string; type: string; context?: string }>;
}

export async function storeMessage(opts: StoreMessageOptions): Promise<void> {
  const { id, timestamp, sender, role, text, entities } = opts;

  let embedding: Float32Array | undefined;
  try {
    embedding = await embedText(text);
  } catch (e) {
    logger.warn("Failed to generate embedding", { error: String(e) });
  }

  insertMessage({ id, timestamp, sender, role, text, embedding });

  if (entities && entities.length > 0) {
    const entityIds: number[] = [];
    for (const entity of entities) {
      const entityId = upsertEntity(entity.name, entity.type, entity.context ? { context: entity.context } : undefined);
      linkMessageToEntity(id, entityId, entity.context);
      entityIds.push(entityId);
    }
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        linkEntities(entityIds[i], entityIds[j], "mentioned_together");
      }
    }
  }
}

/**
 * Build the prompt for the LLM to extract entities from a conversation turn.
 * Includes recent message context so it can resolve pronouns.
 */
export function buildEntityExtractionPrompt(
  currentMessage: string,
  recentMessages: Array<{ sender: string; text: string; role: string }>
): Array<{ role: "system" | "user"; content: string }> {
  const contextBlock = recentMessages
    .map((m) => `[${m.role}] ${m.sender}: ${m.text}`)
    .join("\n");

  return [
    {
      role: "system",
      content: `You are an entity extraction engine. Given a conversation, extract ALL entities (people, places, organizations, topics, activities) mentioned in the LATEST message.

CRITICAL: Resolve pronouns using conversation context. If someone says "she" and a previous message mentions "Alice", then the entity is "Alice", NOT "she". Use the most specific, real name available.

Rules:
- Use real names when available (not pronouns like "she", "he", "they")
- Use full names, not partial ("Alice" not "A")
- Include the relationship/context (e.g. "Alice - user's coworker")
- If no entities found, return empty array
- DO NOT include the assistant's own responses as entities

Respond in EXACTLY this JSON format (no markdown, no fences):
{"entities":[{"name":"Alice","type":"person","context":"user's coworker who is being mean"}]}`,
    },
    {
      role: "user",
      content: `Recent conversation:\n${contextBlock}\n\nLatest message:\n${currentMessage}`,
    },
  ];
}

export interface ExtractedEntity {
  name: string;
  type: string;
  context?: string;
}

export function parseEntityResponse(response: string): ExtractedEntity[] {
  try {
    const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed.entities) ? parsed.entities : [];
  } catch {
    return [];
  }
}

export async function recallMemories(query: string, limit = 10): Promise<{
  semanticMatches: Array<StoredMessage & { score: number }>;
  entityMatches: Array<StoredEntity & { messages: StoredMessage[]; linked: StoredEntity[] }>;
}> {
  let queryEmbedding: Float32Array | undefined;
  try {
    queryEmbedding = await embedText(query);
  } catch (e) {
    logger.warn("Failed to embed query", { error: String(e) });
  }

  const semanticMatches = queryEmbedding
    ? searchMessagesByEmbedding(queryEmbedding, limit)
    : [];

  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const entityMatches: Array<StoredEntity & { messages: StoredMessage[]; linked: StoredEntity[] }> = [];
  const seenEntityIds = new Set<number>();

  for (const word of words) {
    const entities = searchEntities(word, 5);
    for (const entity of entities) {
      if (seenEntityIds.has(entity.id)) continue;
      seenEntityIds.add(entity.id);
      const messages = getMessagesForEntity(entity.id, 5);
      const linked = getLinkedEntities(entity.id, 5);
      entityMatches.push({ ...entity, messages, linked });
    }
  }

  return { semanticMatches, entityMatches };
}

export function getMemoryStats(): {
  totalMessages: number;
  totalEntities: number;
  messagesWithEmbeddings: number;
} {
  const db = getDb();
  const msgCount = (db.prepare("SELECT COUNT(*) as c FROM messages").get() as any).c;
  const entCount = (db.prepare("SELECT COUNT(*) as c FROM entities").get() as any).c;
  const embCount = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE embedding IS NOT NULL").get() as any).c;
  return { totalMessages: msgCount, totalEntities: entCount, messagesWithEmbeddings: embCount };
}

export function getRecentMessageContext(count = 5): Array<{ sender: string; text: string; role: string }> {
  const msgs = getRecentMessages(count);
  return msgs.map((m) => ({ sender: m.sender, text: m.text, role: m.role }));
}

export function getStartupContext(): string {
  const parts: string[] = [];
  const totalMessages = getMessageCount();
  const totalEntities = getEntityCount();

  if (totalMessages === 0) {
    return "[No prior conversation history - this is a fresh start]";
  }

  parts.push(`== MEMORY CONTEXT (${totalMessages} messages, ${totalEntities} entities tracked) ==`);

  const recent = getRecentMessages(30);
  if (recent.length > 0) {
    parts.push("\n-- Recent Messages (last 30) --");
    for (const m of recent) {
      const date = new Date(m.timestamp).toISOString().slice(0, 16).replace("T", " ");
      parts.push(`[${date}] ${m.sender}: ${m.text.slice(0, 300)}`);
    }
  }

  const topEntities = getTopEntities(15);
  if (topEntities.length > 0) {
    parts.push("\n-- Key Entities --");
    for (const e of topEntities) {
      const lastSeen = e.lastMention > 0 ? new Date(e.lastMention).toISOString().slice(0, 10) : "unknown";
      parts.push(`[${e.type}] ${e.name} (mentioned ${e.mentionCount}x, last: ${lastSeen})`);
    }
  }

  const people = topEntities.filter((e) => e.type === "person").slice(0, 8);
  if (people.length > 0) {
    parts.push("\n-- Relationship Graph --");
    for (const person of people) {
      const rels = getEntityRelationships(person.id);
      if (rels.length > 0) {
        const connected = rels.slice(0, 5).map((r) => `${r.entity.name} (${r.entity.type}, weight: ${r.weight.toFixed(1)}, shared: ${r.sharedMessages})`).join(", ");
        parts.push(`${person.name} <-> ${connected}`);
      }
    }
  }

  parts.push("\n== END MEMORY CONTEXT ==");
  return parts.join("\n");
}
