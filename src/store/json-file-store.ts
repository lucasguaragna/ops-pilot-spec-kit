import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { StoreFileError } from "../domain/errors.ts";
import { Alert, Incident, Service } from "../domain/schemas.ts";
import { createInitialState, type StoreBackend, type StoreState } from "./in-memory-store.ts";

export const DEFAULT_DB_PATH = fileURLToPath(new URL("../../data/db.json", import.meta.url));

const StoreStateFile = z.object({
  services: z.array(Service),
  alerts: z.array(Alert),
  incidents: z.array(Incident),
  nextIncidentNumber: z.number().int().positive(),
});

export function parseStoreState(path: string, text: string): StoreState {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new StoreFileError(path, error instanceof Error ? error.message : String(error));
  }
  const parsed = StoreStateFile.safeParse(json);
  if (!parsed.success) throw new StoreFileError(path, z.prettifyError(parsed.error));
  return parsed.data;
}

export function serializeStoreState(state: StoreState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** Writes through a temporary file so a crash never leaves half a database behind. */
export function writeStoreFile(path: string, state: StoreState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, serializeStoreState(state));
  renameSync(temporary, path);
}

/** Reads the database on every call, so edits to the file show up without a restart. */
export function createJsonFileBackend(path: string = DEFAULT_DB_PATH): StoreBackend {
  return {
    load: () => {
      if (!existsSync(path)) writeStoreFile(path, createInitialState());
      return parseStoreState(path, readFileSync(path, "utf8"));
    },
    save: (state) => writeStoreFile(path, state),
  };
}
