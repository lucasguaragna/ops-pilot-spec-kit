import { createInitialState, listAlerts } from "./in-memory-store.ts";

const state = createInitialState();

console.log("Seed loaded");
console.log(`Services: ${state.services.length}`);
console.log(`Alerts firing: ${listAlerts(state, "firing").length}`);
console.log(`Alerts resolved: ${listAlerts(state, "resolved").length}`);
console.log(`Incidents: ${state.incidents.length}`);
