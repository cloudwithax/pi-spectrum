import { DatabaseSync } from "node:sqlite";

const DB_PATH = "./data/memory.db";
const BATCH_SIZE = 10;

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode=WAL");

// Dynamic import for the embedding module
const { embedTexts } = await import("../src/memory/embeddings.ts");

const messages = db.prepare(
  "SELECT id, text FROM messages WHERE embedding IS NULL ORDER BY timestamp ASC"
).all() as any[];

console.log(`Found ${messages.length} messages without embeddings`);

const update = db.prepare("UPDATE messages SET embedding = ? WHERE id = ?");

let done = 0;
for (let i = 0; i < messages.length; i += BATCH_SIZE) {
  const batch = messages.slice(i, i + BATCH_SIZE);
  const embeddings = await embedTexts(batch.map((m: any) => m.text));

  db.exec("BEGIN");
  try {
    for (let j = 0; j < batch.length; j++) {
      const buf = Buffer.from(embeddings[j].buffer);
      update.run(buf, batch[j].id);
      done++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  if (done % 100 === 0 || done === messages.length) {
    console.log(`  ${done}/${messages.length} embeddings generated`);
  }
}

const remaining = (db.prepare("SELECT COUNT(*) as c FROM messages WHERE embedding IS NULL").get() as any).c;
console.log(`\nDone. ${done} embeddings generated. ${remaining} still without embeddings.`);

db.close();
