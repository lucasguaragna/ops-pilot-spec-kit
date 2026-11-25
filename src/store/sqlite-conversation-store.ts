import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { z } from "zod";
import { ConversationNotFoundError, StoreOpenError } from "../domain/errors.ts";
import { ConversationSummary, StoredMessage, type Conversation, type NewMessage } from "../domain/schemas.ts";
import { CoveredCount, parseSummarySave, type ConversationStore } from "./conversation-store.ts";
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

CREATE TABLE IF NOT EXISTS conversation_summaries (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
  summary TEXT NOT NULL CHECK (length(trim(summary, ' ' || char(9) || char(10) || char(13))) > 0),
  covered_messages INTEGER NOT NULL CHECK (covered_messages > 0),
  updated_at TEXT NOT NULL
) STRICT;
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

export const toConversationSummary = (row: Row): ConversationSummary =>
  ConversationSummary.parse({
    conversationId: row.conversation_id,
    summary: row.summary,
    coveredMessages: row.covered_messages,
    updatedAt: row.updated_at,
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
  private readonly selectAfter: StatementSync;
  private readonly selectSummary: StatementSync;
  private readonly insertSummary: StatementSync;
  private readonly updateSummary: StatementSync;

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
      // LIMIT -1 means "no limit"; only the OFFSET is bound, and it is checked to be >= 0 first.
      this.selectAfter = this.db.prepare(
        "SELECT id, conversation_id, role, content, created_at FROM messages " +
          "WHERE conversation_id = ? ORDER BY id LIMIT -1 OFFSET ?",
      );
      this.selectSummary = this.db.prepare(
        "SELECT conversation_id, summary, covered_messages, updated_at " +
          "FROM conversation_summaries WHERE conversation_id = ?",
      );
      this.insertSummary = this.db.prepare(
        "INSERT INTO conversation_summaries " +
          "(conversation_id, summary, covered_messages, updated_at) " +
          "VALUES (?, ?, ?, ?) ON CONFLICT(conversation_id) DO NOTHING",
      );
      this.updateSummary = this.db.prepare(
        "UPDATE conversation_summaries SET summary = ?, covered_messages = ?, updated_at = ? " +
          "WHERE conversation_id = ? AND covered_messages = ?",
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

  messagesAfter(conversationId: string, covered: number): StoredMessage[] {
    const skip = CoveredCount.parse(covered);
    this.requireConversation(conversationId);
    return this.selectAfter.all(conversationId, skip).map(toStoredMessage);
  }

  summaryOf(conversationId: string): ConversationSummary | undefined {
    this.requireConversation(conversationId);
    const row = this.selectSummary.get(conversationId);
    return row ? toConversationSummary(row) : undefined;
  }

  saveSummary(conversationId: string, summary: string, expectedCovered: number, coveredMessages: number): boolean {
    const text = parseSummarySave(summary, expectedCovered, coveredMessages);
    this.requireConversation(conversationId);
    const updatedAt = this.now();
    const { changes } =
      expectedCovered === 0
        ? this.insertSummary.run(conversationId, text, coveredMessages, updatedAt)
        : this.updateSummary.run(text, coveredMessages, updatedAt, conversationId, expectedCovered);
    return Number(changes) === 1;
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
