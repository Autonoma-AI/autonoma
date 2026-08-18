import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { scopeIn } from "@autonoma/utils";
import type { SecretKeys } from "./secret-keys";

const PAGE_SIZE = 200;

export interface ResealOutcome {
    /** Envelopes moved from v1 to v2. */
    resealed: number;
    /** Rows that would not open. Left byte-for-byte alone - see below. */
    unopenable: number;
}

/**
 * Moves every v1 envelope to v2.
 *
 * v1 binds `(applicationId, appName, key)`; v2 binds `(appId, key)`. Authenticated
 * data is not stored anywhere - it is reconstructed by the caller at open time - so
 * the only way to change it is to open each value under the old scope and seal it
 * again under the new one.
 *
 * Runs after the enforcing migration, so every row has an app row to bind to -
 * that is what the migration guarantees by deleting the ones that did not.
 *
 * Idempotent: a row already on v2 is not selected, and a row is written only after
 * its value has been opened and re-sealed successfully.
 *
 * A row that will not open is counted and LEFT ALONE. Overwriting it would make an
 * unrecoverable value permanent, and deleting it would hide that a value nobody can
 * read exists at all.
 *
 * Pages by re-reading the head of the set rather than by cursor. Re-sealing a row
 * takes it out of the `v1.` filter, so the set shrinks underneath the sweep and a
 * cursor into it points at a row that is no longer there - which silently skipped
 * one row per page. The only rows that stay are the ones that would not open, and
 * those are excluded by id, so the loop still terminates.
 */
export async function resealSecrets(db: PrismaClient, keys: SecretKeys, logger?: Logger): Promise<ResealOutcome> {
    const log = logger ?? rootLogger.child({ name: "resealSecrets" });
    const outcome: ResealOutcome = { resealed: 0, unopenable: 0 };

    const unopenableIds: string[] = [];
    for (;;) {
        const page = await db.previewkitSecret.findMany({
            where: {
                envelope: { startsWith: "v1." },
                id: unopenableIds.length > 0 ? { notIn: unopenableIds } : undefined,
            },
            select: { id: true, applicationId: true, appName: true, appId: true, key: true, envelope: true },
            orderBy: { id: "asc" },
            take: PAGE_SIZE,
        });
        if (page.length === 0) return outcome;

        for (const row of page) {
            const v1Scope = scopeIn({ kind: "app", applicationId: row.applicationId, appName: row.appName }, row.key);
            try {
                const opener = await keys.forEnvelope(row.envelope);
                const plaintext = opener.decrypt(row.envelope, v1Scope);
                const sealer = await keys.primary();

                await db.previewkitSecret.update({
                    where: { id: row.id },
                    data: {
                        envelope: sealer.encrypt(plaintext, { ...v1Scope, appId: row.appId }),
                        encryptionKeyId: sealer.keyId,
                    },
                });
                outcome.resealed += 1;
            } catch (err) {
                outcome.unopenable += 1;
                unopenableIds.push(row.id);
                log.error("Could not open a secret to re-seal it; left untouched", {
                    applicationId: row.applicationId,
                    extra: { appName: row.appName, key: row.key, err },
                });
            }
        }
    }
}
