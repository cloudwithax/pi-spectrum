import { DatabaseSync } from "node:sqlite";

const AZ_DB = "/home/clxud/agentzero/agent_memory.db";
const PS_DB = "./data/memory.db";

const az = new DatabaseSync(AZ_DB);
const ps = new DatabaseSync(PS_DB);
ps.exec("PRAGMA journal_mode=WAL");
ps.exec("PRAGMA foreign_keys=ON");

// Ensure pi-spectrum schema exists
ps.exec(`
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
`);

function timestampToEpoch(ts: string): number {
  return new Date(ts.replace(" ", "T") + "Z").getTime();
}

// 1. Import conversations as messages
console.log("Importing conversations...");
const convos = az.prepare("SELECT id, session_id, role, content, created_at FROM conversations ORDER BY created_at ASC").all() as any[];
const insertMsg = ps.prepare("INSERT OR IGNORE INTO messages (id, timestamp, sender, role, text) VALUES (?, ?, ?, ?, ?)");

let imported = 0;
let skipped = 0;
ps.exec("BEGIN");
try {
  for (const c of convos) {
    const id = `az-conv-${c.id}`;
    const timestamp = timestampToEpoch(c.created_at);
    // Map session_id to sender: strip prefix, use phone number or session name
    let sender = c.session_id;
    if (sender.startsWith("imessage_")) sender = sender.slice(9);
    else if (sender.startsWith("tg_")) sender = sender.slice(3);
    else if (sender.startsWith("openai_")) sender = sender.slice(7);

    const role = c.role === "user" ? "user" : "assistant";
    insertMsg.run(id, timestamp, sender, role, c.content);
    imported++;
  }
  ps.exec("COMMIT");
} catch (e) {
  ps.exec("ROLLBACK");
  throw e;
}
console.log(`  Imported ${imported} conversations as messages (${skipped} skipped)`);

// 2. Import topics as entities
console.log("Importing topics as entities...");
const topics = az.prepare("SELECT id, name FROM topics").all() as any[];
const insertEntity = ps.prepare("INSERT OR IGNORE INTO entities (name, type, metadata) VALUES (?, ?, ?)");

const topicToEntityId = new Map<number, number>();
ps.exec("BEGIN");
try {
  for (const t of topics) {
    insertEntity.run(t.name, "topic", null);
    const row = ps.prepare("SELECT id FROM entities WHERE name = ? AND type = ?").get(t.name, "topic") as any;
    topicToEntityId.set(t.id, row.id);
  }
  ps.exec("COMMIT");
} catch (e) {
  ps.exec("ROLLBACK");
  throw e;
}
console.log(`  Imported ${topicToEntityId.size} topics as entities`);

// 3. Import memory-topic links as message-entity links
// We map: memory_id -> topic_id. We need to find which message corresponds to the memory.
// AgentZero memories don't have a direct conversation FK, but some have session_id in metadata.
// We'll link the memory's topic to the most recent message from the same session.
console.log("Importing memory-topic links...");
const memTopics = az.prepare(`
  SELECT mt.memory_id, mt.topic_id, m.content, m.metadata
  FROM memory_topics mt
  JOIN memories m ON m.id = mt.memory_id
`).all() as any[];

const insertME = ps.prepare("INSERT OR IGNORE INTO message_entities (message_id, entity_id, context) VALUES (?, ?, ?)");

let linksImported = 0;
ps.exec("BEGIN");
try {
  for (const mt of memTopics) {
    const entityId = topicToEntityId.get(mt.topic_id);
    if (!entityId) continue;

    // Try to find a message to link to by searching for the memory content in messages
    // Use a prefix match since conversations might have the full text
    const contentPreview = mt.content.slice(0, 100);
    const matchMsg = ps.prepare(
      "SELECT id FROM messages WHERE text LIKE ? LIMIT 1"
    ).get(`%${contentPreview}%`) as any;

    if (matchMsg) {
      insertME.run(matchMsg.id, entityId, `imported from agentzero memory #${mt.memory_id}`);
      linksImported++;
    }
  }
  ps.exec("COMMIT");
} catch (e) {
  ps.exec("ROLLBACK");
  throw e;
}
console.log(`  Imported ${linksImported} memory-topic links`);

// 4. Create entity-entity links from co-occurring topics in the same messages
console.log("Building entity co-occurrence links...");
const cooccur = ps.prepare(`
  SELECT me1.entity_id AS a, me2.entity_id AS b, COUNT(*) AS weight
  FROM message_entities me1
  JOIN message_entities me2 ON me1.message_id = me2.message_id AND me1.entity_id < me2.entity_id
  GROUP BY me1.entity_id, me2.entity_id
  HAVING weight >= 2
  ORDER BY weight DESC
`).all() as any[];

const insertLink = ps.prepare(
  "INSERT INTO entity_links (entity_a_id, entity_b_id, link_type, weight) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET weight = weight + ?"
);

ps.exec("BEGIN");
try {
  for (const row of cooccur) {
    insertLink.run(row.a, row.b, "co-occurrence", row.weight, row.weight);
  }
  ps.exec("COMMIT");
} catch (e) {
  ps.exec("ROLLBACK");
  throw e;
}
console.log(`  Created ${cooccur.length} entity co-occurrence links`);

// Summary
const msgCount = (ps.prepare("SELECT COUNT(*) as c FROM messages").get() as any).c;
const entCount = (ps.prepare("SELECT COUNT(*) as c FROM entities").get() as any).c;
const meCount = (ps.prepare("SELECT COUNT(*) as c FROM message_entities").get() as any).c;
const elCount = (ps.prepare("SELECT COUNT(*) as c FROM entity_links").get() as any).c;
console.log(`\nMigration complete. Final counts:`);
console.log(`  Messages: ${msgCount}`);
console.log(`  Entities: ${entCount}`);
console.log(`  Message-Entity links: ${meCount}`);
console.log(`  Entity-Entity links: ${elCount}`);
console.log(`\nNote: Embeddings need to be regenerated (AgentZero used 2048-dim, pi-spectrum uses 1024-dim).`);
console.log(`The embedding worker will handle this automatically on next startup.`);

az.close();
ps.close();
