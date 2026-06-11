import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SECRETS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), ".secrets.json");

/**
 * Read the decrypted signing secret for an applicationId from the gitignored
 * .secrets.json. Throws with a clear remediation message when the key is absent.
 */
export function loadSigningSecret(applicationId: string): string {
    if (!existsSync(SECRETS_FILE)) {
        throw new Error(
            `No .secrets.json found at ${SECRETS_FILE}. ` +
                "Run the capture command to populate it: pnpm tsx evals/capture/capture-generation.ts <testGenerationId>",
        );
    }

    const secrets = JSON.parse(readFileSync(SECRETS_FILE, "utf-8")) as Record<string, unknown>;
    const secret = secrets[applicationId];

    if (typeof secret !== "string" || secret.length === 0) {
        throw new Error(
            `No signing secret for applicationId "${applicationId}" in ${SECRETS_FILE}. ` +
                "Re-run the capture command to refresh the secrets file.",
        );
    }

    return secret;
}

/** Write or update a signing secret entry in the gitignored .secrets.json. */
export function writeSigningSecret(applicationId: string, signingSecret: string): void {
    let existing: Record<string, unknown> = {};
    if (existsSync(SECRETS_FILE)) {
        try {
            existing = JSON.parse(readFileSync(SECRETS_FILE, "utf-8")) as Record<string, unknown>;
        } catch (err) {
            // Treat a malformed file as empty and overwrite it.
            console.warn("Malformed .secrets.json, overwriting", err);
        }
    }

    const updated = { ...existing, [applicationId]: signingSecret };
    writeFileSync(SECRETS_FILE, JSON.stringify(updated, null, 2) + "\n", "utf-8");
}
