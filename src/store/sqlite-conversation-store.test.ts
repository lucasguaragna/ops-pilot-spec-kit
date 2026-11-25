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

  describe("conversation_summaries", () => {
    const insertSummary = (db: DatabaseSync, conversationId: string, summary: string, covered: number) =>
      db
        .prepare(
          "INSERT INTO conversation_summaries (conversation_id, summary, covered_messages, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(conversationId, summary, covered, AT);

    it("accepts a well-formed row", () => {
      const db = rawDatabase();
      insertSummary(db, "c1", "- a", 8);
    });

    it("rejects a coverage of 0", () => {
      const db = rawDatabase();
      assert.throws(() => insertSummary(db, "c1", "- a", 0), /CHECK constraint failed/);
    });

    it("rejects a blank summary", () => {
      const db = rawDatabase();
      assert.throws(() => insertSummary(db, "c1", "", 8), /CHECK constraint failed/);
      assert.throws(() => insertSummary(db, "c1", "  \n ", 8), /CHECK constraint failed/);
    });

    it("rejects a summary for a conversation that does not exist", () => {
      const db = rawDatabase();
      assert.throws(() => insertSummary(db, "ghost", "- a", 8), FAILED);
    });

    it("allows one summary per conversation", () => {
      const db = rawDatabase();
      insertSummary(db, "c1", "- a", 8);
      assert.throws(() => insertSummary(db, "c1", "- b", 16), /UNIQUE constraint failed|PRIMARY KEY/);
    });
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

  it("returns the same summary after a restart (FR-002)", () => {
    const path = tempFile();
    const summary = "- Page payments\n- eu-west\n- INC-002 open";
    const first = new SqliteConversationStore(path);
    const { id } = first.create();
    assert.equal(first.saveSummary(id, summary, 0, 8), true);
    const before = first.summaryOf(id);
    first.close();

    const second = new SqliteConversationStore(path);
    try {
      assert.deepEqual(second.summaryOf(id), before);
      assert.equal(before?.coveredMessages, 8);
      assert.equal(second.summaryOf(id)?.summary, summary);
    } finally {
      second.close();
    }
  });

  it("opens a database created before summaries existed, adds the table, and keeps every message", () => {
    const path = tempFile();
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE conversations (id TEXT PRIMARY KEY CHECK (length(id) > 0), created_at TEXT NOT NULL) STRICT;
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
    `);
    old.prepare("INSERT INTO conversations (id, created_at) VALUES (?, ?)").run("old", AT);
    for (const content of ["one", "two", "three"]) {
      old.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)").run(
        "old",
        "user",
        content,
        AT,
      );
    }
    old.close();

    const store = new SqliteConversationStore(path);
    try {
      assert.deepEqual(store.messagesAfter("old", 0).map((message) => message.content), ["one", "two", "three"]);
      assert.equal(store.summaryOf("old"), undefined);
      assert.equal(store.saveSummary("old", "- d", 0, 8), true);
    } finally {
      store.close();
    }
  });

  it("rejects a stored row edited by hand into a shape the domain refuses", () => {
    const path = tempFile();
    const store = new SqliteConversationStore(path);
    const { id } = store.create();
    store.saveSummary(id, "- d", 0, 8);
    store.close();

    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE conversation_summaries SET summary = ? WHERE conversation_id = ?").run("\u00a0", id);
    raw.close();

    const reopened = new SqliteConversationStore(path);
    try {
      assert.throws(() => reopened.summaryOf(id));
    } finally {
      reopened.close();
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
