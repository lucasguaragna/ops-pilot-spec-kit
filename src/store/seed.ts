import { relative } from "node:path";
import { createInitialState, listAlerts } from "./in-memory-store.ts";
import { DEFAULT_DB_PATH, writeStoreFile } from "./json-file-store.ts";

const state = createInitialState();
writeStoreFile(DEFAULT_DB_PATH, state);

console.log(`Seed written to ${relative(process.cwd(), DEFAULT_DB_PATH)}`);
console.log(`Services: ${state.services.length}`);
console.log(`Alerts firing: ${listAlerts(state, "firing").length}`);
console.log(`Alerts resolved: ${listAlerts(state, "resolved").length}`);
console.log(`Incidents: ${state.incidents.length}`);
