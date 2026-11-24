import type { RequestHandler } from "express";
import { ConversationNotFoundError, EmbeddingError, UnknownStrategyError } from "../domain/errors.ts";
import {
  conversationNotFoundReply,
  failureOf,
  toHttpReply,
  unknownStrategyReply,
  type HttpReply,
} from "./chat-reply.ts";
import { runChat } from "./chat-service.ts";
import { ChatReply, ChatRequest, ErrorReply, toIssues } from "./schemas.ts";
import type { ResolvedSettings } from "./server.ts";

export function postChat(settings: ResolvedSettings): RequestHandler {
  return async (req, res, next) => {
    try {
      const parsed = ChatRequest.safeParse(req.body);
      if (!parsed.success) {
        const body = ErrorReply.parse({
          error: "invalid_body",
          message: "The request body is invalid",
          issues: toIssues(parsed.error),
        });
        res.status(400).json(body);
        return;
      }
      let reply: HttpReply;
      try {
        const outcome = await runChat(settings, parsed.data);
        const failure = failureOf(outcome);
        if (failure) console.error(`Run failed: ${failure.name}: ${failure.message}`);
        reply = toHttpReply(outcome);
      } catch (error) {
        if (error instanceof UnknownStrategyError) reply = unknownStrategyReply(error);
        else if (error instanceof ConversationNotFoundError) reply = conversationNotFoundReply(error);
        else {
          // The last-resort handler hides every detail from the client, so say here what failed.
          if (error instanceof EmbeddingError) console.error(`Memory recall failed: ${error.message}`);
          throw error;
        }
      }
      // A reply that fails its own schema is a bug: it throws and becomes a 500 (FR-010).
      const { status, body } = reply;
      res.status(status).json(status === 200 ? ChatReply.parse(body) : ErrorReply.parse(body));
    } catch (error) {
      next(error);
    }
  };
}
