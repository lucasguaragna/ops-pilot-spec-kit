import { z } from "zod";
import { strategyFactories } from "./agents/index.ts";
import { createModel } from "./agents/model.ts";
import { createTools } from "./agents/tools.ts";
import { createApp } from "./http/server.ts";
import { StoreOpenError } from "./domain/errors.ts";
import { openConversationStore } from "./store/sqlite-conversation-store.ts";
import { openOpsStore } from "./store/sqlite-ops-store.ts";

const Port = z.coerce.number().int().positive().default(3000);

// Names the problem, never the value.
const parsedPort = Port.safeParse(process.env.PORT);
if (!parsedPort.success) {
  console.error("Invalid setting: PORT must be a positive integer");
  process.exit(1);
}
const port = parsedPort.data;

// The endpoint has no authentication, so it listens on this machine only unless HOST says otherwise.
const host = process.env.HOST?.trim() || "127.0.0.1";

// One connection for the whole process; every request shares it.
let store;
let conversations;
try {
  store = openOpsStore();
  conversations = openConversationStore();
} catch (error) {
  if (!(error instanceof StoreOpenError)) throw error;
  console.error(error.message);
  process.exit(1);
}

const model = createModel();
const app = createApp({
  registry: strategyFactories,
  conversations,
  createDependencies: () => ({
    model,
    tools: [...createTools(store)],
  }),
});

app.listen(port, host, () => console.log(`OpsPilot listening on http://${host}:${port}`));
