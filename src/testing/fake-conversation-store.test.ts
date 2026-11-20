import { runConversationStoreContract } from "../store/conversation-store-contract.ts";
import { FakeConversationStore } from "./fake-conversation-store.ts";

runConversationStoreContract("fake", (options) => new FakeConversationStore(options));
