import { db } from "@autonoma/db";
import type { SecretBundle } from "@autonoma/utils";
import { KMSClient } from "@aws-sdk/client-kms";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { KmsKeyProvider } from "../kms-key-provider";
import { SecretKeys } from "../secret-keys";
import { SecretValues } from "../secret-values";

type Mode = { kind: "get" } | { kind: "set"; value: string };

/**
 * Decrypts or encrypts one previewkit secret value directly against Postgres,
 * for one environment's database - the same read/write path `SecretValues`
 * gives the API, run by hand for an operator who needs to inspect or fix a
 * single row.
 *
 * Deliberately does NOT import a shared env.ts, for the same reason as
 * `apps/previewkit/src/scripts/mint-key.ts`: this needs only the secrets CMK,
 * not whatever else a host's env module demands.
 *
 * `DATABASE_URL` decides which environment is read or written, since every
 * environment has its own database, its own keys, and its own secret rows.
 * Point it at the environment you mean.
 */
const env = createEnv({
    server: {
        PREVIEWKIT_SECRETS_CMK: z.string().min(1),
        AWS_REGION: z.string().default("us-east-1"),
    },
    runtimeEnv: process.env,
});

/**
 * Reads `--name <value>`. A flag with a missing value, or one followed by
 * another flag, is an operator mistake and fails here: left alone it would be
 * indistinguishable from not passing the flag.
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

function requiredFlag(name: string): string {
    const value = flag(name);
    if (value == null) {
        console.error(`--${name} is required.`);
        process.exit(1);
    }
    return value;
}

function resolveMode(): Mode {
    const setValue = flag("set");
    const wantsGet = process.argv.includes("--get");

    if (wantsGet && setValue == null) return { kind: "get" };
    if (!wantsGet && setValue != null) return { kind: "set", value: setValue };

    console.error("Pass exactly one of --get (decrypt and print) or --set <value> (encrypt and store).");
    process.exit(1);
}

const bundle: SecretBundle = {
    kind: "app",
    applicationId: requiredFlag("application-id"),
    appName: requiredFlag("app-name"),
};
const key = requiredFlag("key");
const mode = resolveMode();

const provider = new KmsKeyProvider(new KMSClient({ region: env.AWS_REGION }), env.PREVIEWKIT_SECRETS_CMK);
const values = new SecretValues(db, new SecretKeys(db, provider));

if (mode.kind === "get") {
    const value = await values.get(bundle, key);
    if (value == null) {
        console.error(`No secret "${key}" is stored for application ${bundle.applicationId}, app "${bundle.appName}".`);
        process.exit(1);
    }
    // Printed deliberately - decrypting a value for an operator to read is the whole point of --get.
    console.log(value);
} else {
    await values.put(bundle, [{ key, value: mode.value }]);
    console.log(`Encrypted and stored "${key}" for application ${bundle.applicationId}, app "${bundle.appName}".`);
}

await db.$disconnect();
