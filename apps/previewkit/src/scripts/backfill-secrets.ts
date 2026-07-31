import { db } from "@autonoma/db";
import { KmsKeyProvider, SecretKeys, secretFingerprint, SecretValues, type SecretItem } from "@autonoma/secrets";
import { describeSecretBundle, type SecretBundle } from "@autonoma/utils";
import { KMSClient } from "@aws-sdk/client-kms";
import {
    GetSecretValueCommand,
    ResourceNotFoundException,
    SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Copies the secret values AWS Secrets Manager still owns into Postgres, sealed
 * with the current encryption key.
 *
 * Dual-write only covers writes made since it shipped, so everything untouched
 * since then exists only in AWS. This closes that gap for the database
 * `DATABASE_URL` points at, and doubles as the verifier: it compares
 * `fingerprint` per (bundle, key) and reports what disagrees.
 *
 * Dry-run unless `--apply`, matching scripts/apply-standard-resources.sh. Read
 * the summary first; the interesting output is what it refuses.
 */
const env = createEnv({
    server: {
        // Only the unwrap is needed here, which names no CMK - but KmsKeyProvider
        // takes one for its mint path, and every environment with dual-write on
        // already has this set.
        PREVIEWKIT_SECRETS_CMK: z.string().min(1),
        AWS_REGION: z.string().default("us-east-1"),
    },
    runtimeEnv: process.env,
});

const APPLY = process.argv.includes("--apply");

/**
 * Restricts the run to bundles whose label contains this substring. A migration
 * over every bundle at once is not the first thing to run against production:
 * take one bundle, check what landed, then widen.
 */
const ONLY = ((): string | undefined => {
    const index = process.argv.indexOf("--bundle");
    if (index === -1) return undefined;

    // An empty value would make `label.includes()` true for every bundle, so
    // `--bundle ""` would silently migrate the whole fleet while reading as though
    // it were scoped to one thing.
    const value = process.argv[index + 1];
    if (value == null || value.trim().length === 0 || value.startsWith("--")) {
        console.error("--bundle requires a non-empty value.");
        process.exit(1);
    }
    return value;
})();

interface Bundle {
    bundle: SecretBundle;
    label: string;
    arn: string;
}

interface Outcome {
    sealed: number;
    alreadyCurrent: number;
    pruned: number;
}

/** Bundles with no AWS secret at all: born in Postgres, nothing to back-fill. */
let postgresOnly = 0;

const sm = new SecretsManagerClient({ region: env.AWS_REGION });
const keys = new SecretKeys(
    db,
    new KmsKeyProvider(new KMSClient({ region: env.AWS_REGION }), env.PREVIEWKIT_SECRETS_CMK),
);
const values = new SecretValues(db, keys);

/**
 * Reads the bundle's values from AWS. Returns undefined when the secret is gone,
 * which is deliberately distinguished from an empty one: the service's own reader
 * collapses both to `{}`, and a backfill that did the same would write nothing for
 * a dangling bundle and call it success.
 */
async function readFromAws(arn: string): Promise<Record<string, string> | undefined> {
    const response = await sm.send(new GetSecretValueCommand({ SecretId: arn })).catch((err: unknown) => {
        if (err instanceof ResourceNotFoundException) return undefined;
        throw err;
    });
    if (response == null) return undefined;
    if (response.SecretString == null) return {};

    const parsed: unknown = JSON.parse(response.SecretString);
    if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) return {};

    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") out[key] = value;
    }
    return out;
}

/**
 * Bundles from both tables, enumerated by ARN - never by rebuilding the name, which
 * cannot express the legacy paths.
 *
 * Deliberately unbounded. These tables hold one row per onboarded app or org, not
 * one per event, and a `take` here would silently migrate a subset - the exact
 * class of quiet incompleteness this script exists to rule out.
 */
async function loadBundles(): Promise<Bundle[]> {
    const [apps, orgs] = await Promise.all([
        db.previewkitSecret.findMany({ select: { applicationId: true, appName: true, awsSecretArn: true } }),
        db.previewkitOrgSecret.findMany({ select: { organizationId: true, name: true, awsSecretArn: true } }),
    ]);

    // A bundle registered after Postgres became the store has no AWS secret, so there
    // is nothing to copy from and nothing to compare against - it is already whole.
    // Counted rather than silently dropped, so the summary stays a full account.
    const rows: Array<{ bundle: SecretBundle; arn: string | null }> = [
        ...apps.map((row) => ({
            bundle: { kind: "app" as const, applicationId: row.applicationId, appName: row.appName },
            arn: row.awsSecretArn,
        })),
        ...orgs.map((row) => ({
            bundle: { kind: "org" as const, organizationId: row.organizationId, name: row.name },
            arn: row.awsSecretArn,
        })),
    ];
    postgresOnly = rows.filter(({ arn }) => arn == null).length;

    const backed: Bundle[] = [];
    for (const { bundle, arn } of rows) {
        if (arn != null) backed.push(entry(bundle, arn));
    }
    return backed;
}

function entry(bundle: SecretBundle, arn: string): Bundle {
    return { bundle, label: describeSecretBundle(bundle), arn };
}

/** What Postgres already holds for a bundle, as key -> fingerprint, so nothing has to be decrypted to compare. */
async function mirroredFingerprints(bundle: SecretBundle): Promise<Map<string, string>> {
    const rows =
        bundle.kind === "app"
            ? await db.previewkitSecretValue.findMany({
                  where: { secret: { applicationId: bundle.applicationId, appName: bundle.appName } },
                  select: { key: true, fingerprint: true },
              })
            : await db.previewkitOrgSecretValue.findMany({
                  where: { orgSecret: { organizationId: bundle.organizationId, name: bundle.name } },
                  select: { key: true, fingerprint: true },
              });

    return new Map(rows.map((row) => [row.key, row.fingerprint]));
}

/** An absent `outcome` means the bundle's AWS secret is gone. */
async function processBundle(entry: Bundle): Promise<{ entry: Bundle; outcome?: Outcome }> {
    // Nothing links these two reads, so they go together.
    const [awsValues, mirrored] = await Promise.all([readFromAws(entry.arn), mirroredFingerprints(entry.bundle)]);
    if (awsValues == null) return { entry };

    // AWS is authoritative, so its value wins where the two disagree and a key it no
    // longer has is stale here (deleted before dual-write existed).
    const stale = [...mirrored.keys()].filter((key) => !(key in awsValues));
    const needed: SecretItem[] = Object.entries(awsValues)
        .filter(([key, value]) => mirrored.get(key) !== secretFingerprint(value))
        .map(([key, value]) => ({ key, value }));

    if (APPLY) {
        await values.put(entry.bundle, needed);
        await Promise.all(stale.map((key) => values.remove(entry.bundle, key)));
    }

    return {
        entry,
        outcome: {
            sealed: needed.length,
            alreadyCurrent: Object.keys(awsValues).length - needed.length,
            pruned: stale.length,
        },
    };
}

const all = await loadBundles();
const bundles = ONLY == null ? all : all.filter((entry) => entry.label.includes(ONLY));

if (ONLY != null) console.log(`\nFiltered to ${bundles.length} of ${all.length} bundles matching "${ONLY}".`);

// One AWS secret behind two bundles would have identical values written into both,
// which then diverge silently once AWS is dropped. The only case here that can write
// WRONG rather than incomplete data, so it is refused rather than guessed at.
const byArn = new Map<string, Bundle[]>();
for (const entry of bundles) byArn.set(entry.arn, [...(byArn.get(entry.arn) ?? []), entry]);
const shared = [...byArn.values()].filter((group) => group.length > 1);
const sharedLabels = new Set(shared.flat().map((entry) => entry.label));

const totals: Outcome = { sealed: 0, alreadyCurrent: 0, pruned: 0 };
const dangling: Bundle[] = [];

// Bundles are independent, so they run together rather than paying one AWS round
// trip at a time across the fleet. Capped because each one can also open a write
// transaction, and an operator script has no reason to be the heaviest client the
// database sees.
const CONCURRENCY = 8;
const migratable = bundles.filter((entry) => !sharedLabels.has(entry.label));

for (let start = 0; start < migratable.length; start += CONCURRENCY) {
    const batch = await Promise.all(migratable.slice(start, start + CONCURRENCY).map(processBundle));

    for (const { entry, outcome } of batch) {
        if (outcome == null) {
            dangling.push(entry);
            continue;
        }
        totals.sealed += outcome.sealed;
        totals.alreadyCurrent += outcome.alreadyCurrent;
        totals.pruned += outcome.pruned;
    }
}

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN - nothing written, re-run with --apply"}`);
console.log(`  bundles                : ${bundles.length}`);
if (postgresOnly > 0) console.log(`  postgres-only (skipped): ${postgresOnly}`);
console.log(`  values ${APPLY ? "sealed         " : "to seal        "}: ${totals.sealed}`);
console.log(`  values already current : ${totals.alreadyCurrent}`);
console.log(`  stale values ${APPLY ? "pruned    " : "to prune  "}: ${totals.pruned}`);

if (shared.length > 0) {
    console.log(`\nREFUSED - ${shared.length} AWS secret(s) shared by more than one bundle. Resolve by hand:`);
    for (const group of shared) {
        console.log(`  ${group[0]?.arn.split(":secret:")[1] ?? "?"}`);
        for (const entry of group) console.log(`      ${entry.label}`);
    }
}

if (dangling.length > 0) {
    console.log(`\nDANGLING - ${dangling.length} bundle(s) reference an AWS secret that no longer exists:`);
    for (const entry of dangling) console.log(`  ${entry.label}`);
}

if (totals.sealed === 0 && totals.pruned === 0) {
    console.log("\nPostgres already matches AWS for every bundle it could reach.");
} else if (APPLY) {
    console.log("\nRe-run to confirm it converged: a second pass should report 0 to seal and 0 to prune.");
}

await db.$disconnect();
