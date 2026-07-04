import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ReconcilableFinding } from "../../src";

/**
 * Loads the reconciliation eval fixtures. Each fixture is one real (anonymized) prod investigation run: its
 * problem findings plus the human-annotated gold clustering (which findings share an underlying cause). Only
 * client-identifying proper nouns were genericized - the technical shape (shared files/flags/errors that make a
 * cluster, and the near-misses that must stay apart) is verbatim. See cluster-metrics.ts for how gold is scored.
 */
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

const EvidenceSchema = z.object({
    source: z.string(),
    detail: z.string(),
    file: z.string().optional(),
    lines: z.string().optional(),
    snippet: z.string().optional(),
});

const FindingSchema = z.object({
    id: z.string(),
    slug: z.string(),
    category: z.string(),
    confidence: z.string().optional(),
    headline: z.string(),
    rootCause: z.string().optional(),
    whatHappened: z.string().optional(),
    observedAppIssues: z.string().optional(),
    remediation: z.string().optional(),
    evidence: z.array(EvidenceSchema),
});

const GoldClusterSchema = z.object({
    members: z.array(z.string()).min(2),
    confidence: z.enum(["high", "medium", "low"]),
});

const FixtureSchema = z.object({
    id: z.string(),
    findings: z.array(FindingSchema).min(2),
    gold: z.array(GoldClusterSchema),
});

export interface ReconcileFixture {
    id: string;
    findings: ReconcilableFinding[];
    gold: z.infer<typeof GoldClusterSchema>[];
}

export function loadReconcileFixtures(): ReconcileFixture[] {
    const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
    const fixtures = files.map((file) => {
        const raw: unknown = JSON.parse(readFileSync(join(FIXTURES_DIR, file), "utf8"));
        const parsed = FixtureSchema.parse(raw);
        const memberIds = new Set(parsed.gold.flatMap((c) => c.members));
        const findingIds = new Set(parsed.findings.map((f) => f.id));
        for (const id of memberIds) {
            if (!findingIds.has(id)) throw new Error(`Fixture ${file}: gold member "${id}" is not a finding`);
        }
        return parsed;
    });
    return fixtures.sort((a, b) => a.id.localeCompare(b.id));
}
