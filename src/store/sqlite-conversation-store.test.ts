import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { MessageRole } from "../domain/schemas.ts";
import { runConversationStoreContract } from "./conversation-store-contract.ts";
import { CONVERSATION_SCHEMA, SqliteConversationStore } from "./sqlite-conversation-store.ts";
import { SqliteOpsStore } from "./sqlite-ops-store.ts";

const FAILED = /CHECK constraint failed|FOREIGN KEY constraint failed/;
const AT = "2026-11-20T12:00:00.000Z";

runConversationStoreContract("sqlite", (options) => new SqliteConversationStore(":memory:", options));

/** A raw database with the schema, to insert rows the store would never write. */
function rawDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(CONVERSATION_SCHEMA);
  db.prepare("INSERT INTO conversations (id, created_at) VALUES (?, ?)").run("c1", AT);
  return db;
}

const insertMessage = (db: DatabaseSync, conversationId: string, role: string) =>
  db
    .prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)")
    .run(conversationId, role, "text", AT);

describe("SQLite conversation constraints", () => {
  it("rejects a role outside the closed set", () => {
    const db = rawDatabase();
    assert.throws(() => insertMessage(db, "c1", "system"), /CHECK constraint failed/);
  });

  it("keeps the role CHECK list in step with the zod enum", () => {
    const listed = /role IN \(([^)]*)\)/.exec(CONVERSATION_SCHEMA)?.[1] ?? "";
    const roles = [...listed.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(roles, [...MessageRole.options]);
    const db = rawDatabase();
    for (const role of MessageRole.options) insertMessage(db, "c1", role);
  });

  it("rejects a message for a conversation that does not exist", () => {
    const db = rawDatabase();
    assert.throws(() => insertMessage(db, "ghost", "user"), FAILED);
  });

  it("rejects an empty conversation id", () => {
    const db = rawDatabase();
    assert.throws(
      () => db.prepare("INSERT INTO conversations (id, created_at) VALUES (?, ?)").run("", AT),
      /CHECK constraint failed/,
    );
  });
});

describe("SqliteConversationStore on a file", () => {
  const dirs: string[] = [];
  const tempFile = () => {
    const dir = mkdtempSync(join(tmpdir(), "opspilot-conv-"));
    dirs.push(dir);
    return join(dir, "test.db");
  };
  after(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  it("reads the same messages back after a restart", () => {
    const path = tempFile();
    const first = new SqliteConversationStore(path);
    const { id } = first.create();
    first.append(id, { role: "user", content: "which alerts are firing?" });
    first.append(id, { role: "assistant", content: "two alerts" });
    const before = first.lastMessages(id, 12);
    first.close();

    const second = new SqliteConversationStore(path);
    try {
      assert.deepEqual(second.lastMessages(id, 12), before);
      assert.equal(before.length, 2);
    } finally {
      second.close();
    }
  });

  it("opens twice on the same file without losing rows", () => {
    const path = tempFile();
    const first = new SqliteConversationStore(path);
    const { id } = first.create();
    first.append(id, { role: "user", content: "kept" });
    first.close();

    new SqliteConversationStore(path).close();
    const third = new SqliteConversationStore(path);
    try {
      assert.deepEqual(third.lastMessages(id, 12).map((message) => message.content), ["kept"]);
    } finally {
      third.close();
    }
  });

  it("shares one file with the operations store", () => {
    const path = tempFile();
    const ops = new SqliteOpsStore(path);
    const conversations = new SqliteConversationStore(path);
    try {
      const incident = ops.openIncident({ title: "Checkout latency", service: "checkout-api", severity: "high" });
      const { id } = conversations.create();
      conversations.append(id, { role: "user", content: "hi" });
      assert.equal(ops.listIncidents("all")[0]?.id, incident.id);
      assert.equal(conversations.lastMessages(id, 12).length, 1);
    } finally {
      conversations.close();
      ops.close();
    }
  });
});
