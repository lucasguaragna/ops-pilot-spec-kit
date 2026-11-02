import type { RequestHandler } from "express";
import { UnknownStrategyError } from "../domain/errors.ts";
import { toHttpReply, unknownStrategyReply, type HttpReply } from "./chat-reply.ts";
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
        reply = toHttpReply(await runChat(settings, parsed.data));
      } catch (error) {
        if (!(error instanceof UnknownStrategyError)) throw error;
        reply = unknownStrategyReply(error);
      }
      // A reply that fails its own schema is a bug: it throws and becomes a 500 (FR-010).
      const { status, body } = reply;
      res.status(status).json(status === 200 ? ChatReply.parse(body) : ErrorReply.parse(body));
    } catch (error) {
      next(error);
    }
  };
}
