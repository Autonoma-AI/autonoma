import { db } from "@autonoma/db";
import { KmsKeyProvider, mintSecretKey } from "@autonoma/secrets";
import { KMSClient } from "@aws-sdk/client-kms";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Mints the encryption key that seals previewkit secret values, for one
 * environment's database.
 *
 * Deliberately does NOT import `src/env.ts`: the runner's env demands GitHub
 * credentials and an HMAC secret that minting has no use for, and requiring them
 * would make this unrunnable in exactly the situation it exists for.
 *
 * `DATABASE_URL` decides which environment is minted for, since every
 * environment has its own database and its own keys. Point it at the environment
 * you mean.
 */
const env = createEnv({
    server: {
        // Needed only to MINT. Unwrapping names no CMK, because a symmetric KMS
        // ciphertext identifies its own key - which is why the runner itself does
        // not carry this.
        PREVIEWKIT_SECRETS_CMK: z.string().min(1),
        AWS_REGION: z.string().default("us-east-1"),
    },
    runtimeEnv: process.env,
});

/** Key ids are permanent and appear in every envelope, so a new one is the next unused integer. */
function nextKeyId(existing: readonly string[]): string {
    const numbers = existing.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
    return String(numbers.length === 0 ? 1 : Math.max(...numbers) + 1);
}

/**
 * Reads `--name <value>`. A flag with a missing value, or one followed by another
 * flag, is an operator mistake and fails here: left alone it would be
 * indistinguishable from not passing the flag, so `--key-id` with nothing after it
 * would quietly mint under a derived id, and `--key-id --rotate` would mint a key
 * actually named "--rotate" (which the key-id pattern happens to accept).
 */
function flag(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return undefined;

    const value = process.argv[index + 1];
    if (value == null || value.startsWith("--")) {
        console.error(`--${name} requires a value.`);
        process.exit(1);
    }
    return value;
}

const existing = await db.previewkitEncryptionKey.findMany({ orderBy: { createdAt: "asc" } });
const requested = flag("key-id");
const rotating = existing.length > 0;

// Minting promotes immediately, so a second key starts a rotation: new writes seal
// under it while everything already stored still needs the old one. That is a
// deliberate act, not something to do by running this twice.
if (rotating && requested == null && !process.argv.includes("--rotate")) {
    console.error(
        `Refusing to mint: this database already has ${existing.length} encryption key(s) ` +
            `(${existing.map((row) => row.id).join(", ")}).\n\n` +
            `Minting another promotes it to primary and starts a rotation - values already stored\n` +
            `keep needing their current key until they are re-encrypted. If that is what you want,\n` +
            `re-run with --rotate (or --key-id <id> to choose the id yourself).`,
    );
    process.exit(1);
}

const keyId = requested ?? nextKeyId(existing.map((row) => row.id));
const provider = new KmsKeyProvider(new KMSClient({ region: env.AWS_REGION }), env.PREVIEWKIT_SECRETS_CMK);

await mintSecretKey({ db, provider, keyId });

const rows = await db.previewkitEncryptionKey.findMany({ orderBy: { createdAt: "asc" } });
console.log(`\nMinted encryption key "${keyId}" and promoted it to primary.`);
console.log(`Keys in this database: ${rows.map((row) => `${row.id}${row.primary ? " (primary)" : ""}`).join(", ")}`);

if (rotating) {
    console.log(
        `\nRotation started. Re-encrypt values still sealed under an older key, then delete that\n` +
            `key's row - the RESTRICT foreign key refuses the delete until nothing references it.`,
    );
}

await db.$disconnect();
