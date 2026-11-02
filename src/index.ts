import { z } from "zod";
import { strategyFactories } from "./agents/index.ts";
import { createModel } from "./agents/model.ts";
import { createTools } from "./agents/tools.ts";
import { createApp } from "./http/server.ts";
import { createStore } from "./store/in-memory-store.ts";
import { createJsonFileBackend } from "./store/json-file-store.ts";

const Port = z.coerce.number().int().positive().default(3000);

// Names the problem, never the value.
const parsedPort = Port.safeParse(process.env.PORT);
if (!parsedPort.success) {
  console.error("Invalid setting: PORT must be a positive integer");
  process.exit(1);
}
const port = parsedPort.data;

const model = createModel();
const app = createApp({
  registry: strategyFactories,
  createDependencies: () => ({
    model,
    tools: [...createTools(createStore(createJsonFileBackend()))],
  }),
});

app.listen(port, () => console.log(`OpsPilot listening on http://localhost:${port}`));
