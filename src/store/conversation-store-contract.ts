import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConversationNotFoundError } from "../domain/errors.ts";
import type { ConversationStore } from "./conversation-store.ts";

export const CONTRACT_NOW = "2026-11-20T12:00:00.000Z";

export interface ConversationStoreOptions {
  now: () => string;
  newId: () => string;
}

/**
 * Behaviour every ConversationStore must share. Not a *.test.ts file, so the runner only loads it
 * through the store test files that import it.
 */
export function runConversationStoreContract(
  label: string,
  makeStore: (options: ConversationStoreOptions) => ConversationStore,
): void {
  describe(`ConversationStore contract: ${label}`, () => {
    const fresh = () => {
      let counter = 0;
      return makeStore({ now: () => CONTRACT_NOW, newId: () => `conv-${++counter}` });
    };

    it("creates an empty conversation", () => {
      const store = fresh();
      const conversation = store.create();
      assert.equal(conversation.createdAt, CONTRACT_NOW);
      assert.deepEqual(store.lastMessages(conversation.id, 12), []);
    });

    it("gives every conversation a different id", () => {
      const store = fresh();
      assert.notEqual(store.create().id, store.create().id);
    });

    it("returns the stored message with its conversation, role, content, and time", () => {
      const store = fresh();
      const { id } = store.create();
      const stored = store.append(id, { role: "user", content: "which alerts are firing?" });
      assert.equal(stored.conversationId, id);
      assert.equal(stored.role, "user");
      assert.equal(stored.content, "which alerts are firing?");
      assert.equal(stored.createdAt, CONTRACT_NOW);
      assert.equal(typeof stored.id, "number");
    });

    it("returns the messages in the order they were appended", () => {
      const store = fresh();
      const { id } = store.create();
      store.append(id, { role: "user", content: "first" });
      store.append(id, { role: "assistant", content: "second" });
      store.append(id, { role: "user", content: "third" });
      assert.deepEqual(
        store.lastMessages(id, 12).map((message) => [message.role, message.content]),
        [
          ["user", "first"],
          ["assistant", "second"],
          ["user", "third"],
        ],
      );
    });

    it("returns only the newest messages, oldest first, when there are more than the limit", () => {
      const store = fresh();
      const { id } = store.create();
      for (let n = 1; n <= 20; n++) store.append(id, { role: n % 2 === 1 ? "user" : "assistant", content: `m${n}` });
      const contents = store.lastMessages(id, 12).map((message) => message.content);
      assert.deepEqual(contents, Array.from({ length: 12 }, (_, index) => `m${index + 9}`));
    });

    it("returns every message when there are fewer than the limit", () => {
      const store = fresh();
      const { id } = store.create();
      for (let n = 1; n <= 5; n++) store.append(id, { role: "user", content: `m${n}` });
      assert.equal(store.lastMessages(id, 12).length, 5);
    });

    it("returns nothing for a limit of 0", () => {
      const store = fresh();
      const { id } = store.create();
      store.append(id, { role: "user", content: "hi" });
      assert.deepEqual(store.lastMessages(id, 0), []);
    });

    it("keeps messages of one conversation out of another", () => {
      const store = fresh();
      const a = store.create();
      const b = store.create();
      store.append(a.id, { role: "user", content: "for a" });
      store.append(b.id, { role: "user", content: "for b" });
      assert.deepEqual(store.lastMessages(a.id, 12).map((message) => message.content), ["for a"]);
      assert.deepEqual(store.lastMessages(b.id, 12).map((message) => message.content), ["for b"]);
    });

    it("stores empty and awkward text verbatim", () => {
      const store = fresh();
      const { id } = store.create();
      const awkward = "x'); DROP TABLE messages;--";
      store.append(id, { role: "user", content: awkward });
      store.append(id, { role: "assistant", content: "" });
      assert.deepEqual(store.lastMessages(id, 12).map((message) => message.content), [awkward, ""]);
    });

    it("throws ConversationNotFoundError carrying the id for an unknown conversation", () => {
      const store = fresh();
      const isNotFound = (error: unknown) =>
        error instanceof ConversationNotFoundError && error.conversationId === "missing";
      assert.throws(() => store.append("missing", { role: "user", content: "hi" }), isNotFound);
      assert.throws(() => store.lastMessages("missing", 12), isNotFound);
    });
  });
}
