// Explicit, destructive reset (FR-004a): deletes every incident and restores the seeded records.
// Opening the store only adds missing seed rows; this is the only way to undo changes made after it.
import { relative } from "node:path";
import { StoreOpenError } from "../domain/errors.ts";
import { resolveDbPath, openOpsStore } from "./sqlite-ops-store.ts";

try {
  const store = openOpsStore();
  store.reset();
  const state = store.getState();
  store.close();

  console.log(`Seed written to ${relative(process.cwd(), resolveDbPath(process.env)) || "."}`);
  console.log(`Services: ${state.services.length}`);
  console.log(`Alerts: ${state.alerts.length}`);
  console.log(`Runbooks: ${state.runbooks.length}`);
  console.log(`Incidents: ${state.incidents.length}`);
} catch (error) {
  if (!(error instanceof StoreOpenError)) throw error;
  console.error(error.message);
  process.exit(1);
}
