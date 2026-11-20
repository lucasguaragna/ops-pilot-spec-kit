import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { z } from "zod";
import { ConversationNotFoundError, StoreOpenError } from "../domain/errors.ts";
import { StoredMessage, type Conversation, type NewMessage } from "../domain/schemas.ts";
import type { ConversationStore } from "./conversation-store.ts";
import { resolveDbPath } from "./sqlite-ops-store.ts";

/**
 * The role CHECK is literal text on purpose: it is the second line of defence, so it must not move
 * with the zod enum. A parity test keeps the two in step.
 */
export const CONVERSATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY CHECK (length(id) > 0),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages (conversation_id, id);
`;

type Row = Record<string, unknown>;

// Every row is parsed with the domain schema, so a row edited by hand fails loudly.
export const toStoredMessage = (row: Row): StoredMessage =>
  StoredMessage.parse({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  });

const Limit = z.number().int().nonnegative();

/** SQLite behind `ConversationStore`. Every value goes through a prepared statement; `exec` only sees constant text. */
export class SqliteConversationStore implements ConversationStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly newId: () => string;

  private readonly insertConversation: StatementSync;
  private readonly selectConversation: StatementSync;
  private readonly insertMessage: StatementSync;
  private readonly selectLast: StatementSync;

  constructor(path: string, options: { now?: () => string; newId?: () => string } = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? randomUUID;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      this.db.exec(CONVERSATION_SCHEMA);

      this.insertConversation = this.db.prepare("INSERT INTO conversations (id, created_at) VALUES (?, ?)");
      this.selectConversation = this.db.prepare("SELECT id FROM conversations WHERE id = ?");
      this.insertMessage = this.db.prepare(
        "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
      );
      // The newest N by rowid, then put back in chronological order. Rowids cannot tie; timestamps can.
      this.selectLast = this.db.prepare(
        "SELECT id, conversation_id, role, content, created_at FROM (" +
          "SELECT id, conversation_id, role, content, created_at FROM messages " +
          "WHERE conversation_id = ? ORDER BY id DESC LIMIT ?" +
          ") ORDER BY id",
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  create(): Conversation {
    const conversation = { id: this.newId(), createdAt: this.now() };
    this.insertConversation.run(conversation.id, conversation.createdAt);
    return conversation;
  }

  append(conversationId: string, message: NewMessage): StoredMessage {
    this.requireConversation(conversationId);
    const createdAt = this.now();
    const { lastInsertRowid } = this.insertMessage.run(conversationId, message.role, message.content, createdAt);
    return { id: Number(lastInsertRowid), conversationId, role: message.role, content: message.content, createdAt };
  }

  lastMessages(conversationId: string, limit: number): StoredMessage[] {
    // A negative LIMIT means "no limit" in SQLite, so the value is checked before it is bound.
    const count = Limit.parse(limit);
    this.requireConversation(conversationId);
    return this.selectLast.all(conversationId, count).map(toStoredMessage);
  }

  private requireConversation(conversationId: string): void {
    if (!this.selectConversation.get(conversationId)) throw new ConversationNotFoundError(conversationId);
  }
}

/** Creates the directory if needed and opens the store. Any failure becomes a `StoreOpenError` naming the path. */
export function openConversationStore(
  env: NodeJS.ProcessEnv = process.env,
  options: { now?: () => string; newId?: () => string } = {},
): SqliteConversationStore {
  const path = resolveDbPath(env);
  try {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    return new SqliteConversationStore(path, options);
  } catch (error) {
    throw new StoreOpenError(path, error instanceof Error ? error.message : String(error));
  }
}
