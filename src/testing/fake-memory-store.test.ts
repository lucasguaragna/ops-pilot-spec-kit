import { runMemoryStoreContract } from "../memory/memory-store-contract.ts";
import { FakeMemoryStore } from "./fake-memory-store.ts";

runMemoryStoreContract("fake", (options) => new FakeMemoryStore(options));
