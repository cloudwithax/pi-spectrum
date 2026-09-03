import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

let db: DatabaseSync | null = null;

export function getDb(dbPath?: string): DatabaseSync {
  if (db) return db;
  const path = dbPath ?? process.env.MEMORY_DB_PATH ?? "./data/memory.db";
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");
  initSchema(db);
  return db;
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      sender TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB
    );

    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL COLLATE NOCASE,
      type TEXT NOT NULL,
      mention_count INTEGER DEFAULT 1,
      metadata TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_type ON entities(name, type);

    CREATE TABLE IF NOT EXISTS message_entities (
      message_id TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      context TEXT,
      PRIMARY KEY (message_id, entity_id),
      FOREIGN KEY (message_id) REFERENCES messages(id),
      FOREIGN KEY (entity_id) REFERENCES entities(id)
    );

    CREATE TABLE IF NOT EXISTS entity_links (
      entity_a_id INTEGER NOT NULL,
      entity_b_id INTEGER NOT NULL,
      link_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      PRIMARY KEY (entity_a_id, entity_b_id, link_type),
      FOREIGN KEY (entity_a_id) REFERENCES entities(id),
      FOREIGN KEY (entity_b_id) REFERENCES entities(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
    CREATE INDEX IF NOT EXISTS idx_message_entities_entity ON message_entities(entity_id);

    CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      schedule TEXT NOT NULL,
      prompt TEXT NOT NULL,
      silent INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      fire_at INTEGER,
      next_fire INTEGER,
      enabled INTEGER DEFAULT 1,
      last_fired INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_timers_enabled ON timers(enabled);
    CREATE INDEX IF NOT EXISTS idx_timers_next_fire ON timers(next_fire);
  `);
}

export interface StoredMessage {
  id: string;
  timestamp: number;
  sender: string;
  role: "user" | "assistant";
  text: string;
  embedding?: Float32Array;
}

export interface StoredEntity {
  id: number;
  name: string;
  type: string;
  mentionCount: number;
  metadata?: Record<string, unknown>;
}

export function insertMessage(msg: StoredMessage): void {
  const db = getDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO messages (id, timestamp, sender, role, text, embedding) VALUES (?, ?, ?, ?, ?, ?)"
  );
  stmt.run(
    msg.id,
    msg.timestamp,
    msg.sender,
    msg.role,
    msg.text,
    msg.embedding ? Buffer.from(msg.embedding.buffer) : null
  );
}

export function insertMessages(msgs: StoredMessage[]): void {
  const db = getDb();
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO messages (id, timestamp, sender, role, text, embedding) VALUES (?, ?, ?, ?, ?, ?)"
  );
  db.exec("BEGIN");
  try {
    for (const msg of msgs) {
      stmt.run(
        msg.id,
        msg.timestamp,
        msg.sender,
        msg.role,
        msg.text,
        msg.embedding ? Buffer.from(msg.embedding.buffer) : null
      );
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getMessagesWithoutEmbeddings(limit = 100): StoredMessage[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, timestamp, sender, role, text FROM messages WHERE embedding IS NULL ORDER BY timestamp ASC LIMIT ?"
  ).all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    sender: r.sender,
    role: r.role,
    text: r.text,
  }));
}

export function updateMessageEmbedding(id: string, embedding: Float32Array): void {
  const db = getDb();
  db.prepare("UPDATE messages SET embedding = ? WHERE id = ?").run(
    Buffer.from(embedding.buffer),
    id
  );
}

export function upsertEntity(name: string, type: string, metadata?: Record<string, unknown>): number {
  const db = getDb();
  const existing = db.prepare(
    "SELECT id FROM entities WHERE name = ? AND type = ?"
  ).get(name, type) as any;
  if (existing) {
    db.prepare("UPDATE entities SET mention_count = mention_count + 1 WHERE id = ?").run(existing.id);
    return existing.id;
  }
  const result = db.prepare(
    "INSERT INTO entities (name, type, metadata) VALUES (?, ?, ?)"
  ).run(name, type, metadata ? JSON.stringify(metadata) : null);
  return Number(result.lastInsertRowid);
}

export function linkMessageToEntity(messageId: string, entityId: number, context?: string): void {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO message_entities (message_id, entity_id, context) VALUES (?, ?, ?)"
  ).run(messageId, entityId, context ?? null);
}

export function linkEntities(entityAId: number, entityBId: number, linkType: string, weight = 1.0): void {
  if (entityAId === entityBId) return;
  const db = getDb();
  const [a, b] = entityAId < entityBId ? [entityAId, entityBId] : [entityBId, entityAId];
  db.prepare(
    "INSERT INTO entity_links (entity_a_id, entity_b_id, link_type, weight) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET weight = weight + ?"
  ).run(a, b, linkType, weight, weight);
}

export function searchMessagesByEmbedding(embedding: Float32Array, limit = 10): Array<StoredMessage & { score: number }> {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, timestamp, sender, role, text, embedding FROM messages WHERE embedding IS NOT NULL"
  ).all() as any[];

  const queryVec = embedding;
  const results: Array<StoredMessage & { score: number }> = [];

  for (const row of rows) {
    const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    const score = cosineSimilarity(queryVec, stored);
    results.push({
      id: row.id,
      timestamp: row.timestamp,
      sender: row.sender,
      role: row.role,
      text: row.text,
      score,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

export function getEntityByName(name: string): StoredEntity | undefined {
  const db = getDb();
  const row = db.prepare(
    "SELECT id, name, type, mention_count, metadata FROM entities WHERE name = ?"
  ).get(name) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    mentionCount: row.mention_count,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

export function getMessagesForEntity(entityId: number, limit = 20): StoredMessage[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.id, m.timestamp, m.sender, m.role, m.text
    FROM messages m
    JOIN message_entities me ON m.id = me.message_id
    WHERE me.entity_id = ?
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(entityId, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    sender: r.sender,
    role: r.role,
    text: r.text,
  }));
}

export function getLinkedEntities(entityId: number, limit = 10): Array<StoredEntity & { weight: number }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT e.id, e.name, e.type, e.mention_count, el.weight
    FROM entities e
    JOIN entity_links el ON (el.entity_a_id = ? AND e.id = el.entity_b_id) OR (el.entity_b_id = ? AND e.id = el.entity_a_id)
    ORDER BY el.weight DESC
    LIMIT ?
  `).all(entityId, entityId, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    mentionCount: r.mention_count,
    weight: r.weight,
  }));
}

export function searchEntities(query: string, limit = 10): StoredEntity[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT id, name, type, mention_count, metadata FROM entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT ?"
  ).all(`%${query}%`, limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    mentionCount: r.mention_count,
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
  }));
}

export function getRecentMessages(limit = 20, sender?: string): StoredMessage[] {
  const db = getDb();
  let query = "SELECT id, timestamp, sender, role, text FROM messages";
  const params: any[] = [];
  if (sender) {
    query += " WHERE sender = ?";
    params.push(sender);
  }
  query += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);
  const rows = db.prepare(query).all(...params) as any[];
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    sender: r.sender,
    role: r.role,
    text: r.text,
  })).reverse();
}

// --- Timer CRUD ---

export interface StoredTimer {
  id: string;
  type: "oneoff" | "recurring";
  schedule: string;
  prompt: string;
  silent: boolean;
  createdAt: number;
  fireAt: number | null;
  nextFire: number | null;
  enabled: boolean;
  lastFired: number | null;
}

export function insertTimer(timer: StoredTimer): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO timers (id, type, schedule, prompt, silent, created_at, fire_at, next_fire, enabled, last_fired) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    timer.id,
    timer.type,
    timer.schedule,
    timer.prompt,
    timer.silent ? 1 : 0,
    timer.createdAt,
    timer.fireAt,
    timer.nextFire,
    timer.enabled ? 1 : 0,
    timer.lastFired
  );
}

export function getTimer(id: string): StoredTimer | undefined {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM timers WHERE id = ?"
  ).get(id) as any;
  if (!row) return undefined;
  return rowToTimer(row);
}

export function getEnabledTimers(): StoredTimer[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM timers WHERE enabled = 1"
  ).all() as any[];
  return rows.map(rowToTimer);
}

export function getAllTimers(): StoredTimer[] {
  const db = getDb();
  const rows = db.prepare("SELECT * FROM timers").all() as any[];
  return rows.map(rowToTimer);
}

export function updateTimer(id: string, updates: Partial<Pick<StoredTimer, "nextFire" | "lastFired" | "enabled">>): void {
  const db = getDb();
  const sets: string[] = [];
  const values: any[] = [];
  if (updates.nextFire !== undefined) { sets.push("next_fire = ?"); values.push(updates.nextFire); }
  if (updates.lastFired !== undefined) { sets.push("last_fired = ?"); values.push(updates.lastFired); }
  if (updates.enabled !== undefined) { sets.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE timers SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function deleteTimer(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM timers WHERE id = ?").run(id);
  return result.changes > 0;
}

function rowToTimer(row: any): StoredTimer {
  return {
    id: row.id,
    type: row.type,
    schedule: row.schedule,
    prompt: row.prompt,
    silent: row.silent === 1,
    createdAt: row.created_at,
    fireAt: row.fire_at,
    nextFire: row.next_fire,
    enabled: row.enabled === 1,
    lastFired: row.last_fired,
  };
}

// --- Chat History Queries ---

export interface ChatHistoryQuery {
  sender?: string;
  entityName?: string;
  keyword?: string;
  sinceTimestamp?: number;
  untilTimestamp?: number;
  limit?: number;
}

export function queryMessages(filters: ChatHistoryQuery): StoredMessage[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (filters.sender) {
    conditions.push("m.sender = ?");
    params.push(filters.sender);
  }
  if (filters.sinceTimestamp) {
    conditions.push("m.timestamp >= ?");
    params.push(filters.sinceTimestamp);
  }
  if (filters.untilTimestamp) {
    conditions.push("m.timestamp <= ?");
    params.push(filters.untilTimestamp);
  }
  if (filters.keyword) {
    conditions.push("m.text LIKE ?");
    params.push(`%${filters.keyword}%`);
  }
  if (filters.entityName) {
    conditions.push("m.id IN (SELECT me.message_id FROM message_entities me JOIN entities e ON me.entity_id = e.id WHERE e.name LIKE ?)");
    params.push(`%${filters.entityName}%`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters.limit ?? 50;

  const rows = db.prepare(
    `SELECT m.id, m.timestamp, m.sender, m.role, m.text FROM messages m ${where} ORDER BY m.timestamp DESC LIMIT ?`
  ).all(...params, limit) as any[];

  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    sender: r.sender,
    role: r.role,
    text: r.text,
  })).reverse();
}

export function getTopEntities(limit = 20): Array<StoredEntity & { lastMention: number }> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT e.id, e.name, e.type, e.mention_count, e.metadata,
           COALESCE(MAX(m.timestamp), 0) as last_mention
    FROM entities e
    LEFT JOIN message_entities me ON e.id = me.entity_id
    LEFT JOIN messages m ON me.message_id = m.id
    GROUP BY e.id
    ORDER BY e.mention_count DESC
    LIMIT ?
  `).all(limit) as any[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    mentionCount: r.mention_count,
    metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    lastMention: r.last_mention,
  }));
}

export function getEntityByNameFuzzy(name: string): StoredEntity | undefined {
  const db = getDb();
  const row = db.prepare(
    "SELECT id, name, type, mention_count, metadata FROM entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT 1"
  ).get(`%${name}%`) as any;
  if (!row) return undefined;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    mentionCount: row.mention_count,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

export function getEntityRelationships(entityId: number): Array<{
  entity: StoredEntity;
  linkType: string;
  weight: number;
  sharedMessages: number;
}> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT e.id, e.name, e.type, e.mention_count, e.metadata,
           el.link_type, el.weight,
           (SELECT COUNT(*) FROM message_entities me1
            JOIN message_entities me2 ON me1.message_id = me2.message_id
            WHERE me1.entity_id = ? AND me2.entity_id = e.id) as shared_messages
    FROM entities e
    JOIN entity_links el ON (el.entity_a_id = ? AND e.id = el.entity_b_id) OR (el.entity_b_id = ? AND e.id = el.entity_a_id)
    ORDER BY el.weight DESC
  `).all(entityId, entityId, entityId) as any[];
  return rows.map((r) => ({
    entity: {
      id: r.id,
      name: r.name,
      type: r.type,
      mentionCount: r.mention_count,
      metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
    },
    linkType: r.link_type,
    weight: r.weight,
    sharedMessages: r.shared_messages,
  }));
}

export function getMessageCount(): number {
  const db = getDb();
  return (db.prepare("SELECT COUNT(*) as c FROM messages").get() as any).c;
}

export function getEntityCount(): number {
  const db = getDb();
  return (db.prepare("SELECT COUNT(*) as c FROM entities").get() as any).c;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
