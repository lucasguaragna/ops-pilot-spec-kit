# Quickstart: Persistent Conversation

## Automated checks

```bash
npm run typecheck
npm test
```

Expected: both pass. The new suites are the `ConversationStore` contract (fake and SQLite on
`":memory:"`), the SQLite CHECK and restart tests, `composeInput` and `withHistory`, the
`messagesToSave` and `toHttpReply` tables, and the `/chat` HTTP tests running on the fake store.

## Manual run

Prerequisites: an OpenRouter key set in your environment (never in a committed file) and the
default database, or `OPSPILOT_DB` pointing to a scratch path.

```bash
npm run dev
```

1. Start a conversation:

   ```bash
   curl -s localhost:3000/chat -H 'content-type: application/json' \
     -d '{"message":"which alerts are firing on checkout?","reflect":false}'
   ```

   Expected: a 200 reply with a new `conversationId` and `metrics.historyMessages` = 0.

2. Follow up in that conversation, using the id from step 1:

   ```bash
   curl -s localhost:3000/chat -H 'content-type: application/json' \
     -d '{"message":"open an incident for the worst one","reflect":false,"conversationId":"<id>"}'
   ```

   Expected: the same `conversationId`, `historyMessages` = 2, and an answer that refers to the
   checkout alert from step 1.

3. Restart `npm run dev` and repeat step 2 with the same id. Expected: `historyMessages` = 4.

4. Send a random UUID as `conversationId`. Expected: 404 `conversation_not_found`.

5. Send `"conversationId":"abc"`. Expected: 400 `invalid_body` with the issue path
   `["conversationId"]`.

See [contracts/chat-api.md](contracts/chat-api.md) for the full reply shapes.
