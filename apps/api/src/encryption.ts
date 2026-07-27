import { EncryptionHelper } from "@autonoma/scenario";
import { env } from "./env";

/**
 * Encryption helper backing the always-on scenario SDK (org secrets, webhook
 * shared secrets). Lives in its own leaf module rather than `context.ts` so
 * modules that need only this can import it without pulling in the whole app
 * wiring - `context.ts` opens a Redis connection at module scope and refuses to
 * load under `TESTING`, which makes it unimportable from anything a test reaches.
 */
export const encryptionHelper = new EncryptionHelper(env.SCENARIO_ENCRYPTION_KEY);
