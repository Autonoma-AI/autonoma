import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Codebase } from "@autonoma/diffs";
import { type ReporterInput, type ReporterScenarioRecipe, serializeReporterInput } from "@autonoma/diffs/analysis";
import type { StorageProvider } from "@autonoma/storage";
import { describe, expect, it } from "vitest";
import { casesDir } from "../evals/framework/cases-dir";
import { rehydrateReporterInput, reporterCaseInputSchema } from "../evals/reporter/reporter-input";

/** The committed synthetic example case, present in this repo but stripped from the public mirror. */
const EXAMPLE_CASE = path.join(casesDir("reporter"), "example-synthetic", "input.json");

/**
 * Proves the property the Reporter corpus depends on, over an input that populates every nested field at once:
 * freezing the assembled input and rehydrating it returns the same facts through JSON, with the codebase reduced
 * to coords, the screenshots to keys, and the scenario recipes to a pure lookup. A silent loss here would not fail
 * loudly - it would quietly grade the Reporter on less than production gave it. Field-shape drift is prevented at
 * compile time (the payload composes the same DTO schemas the interfaces infer from); this exercises the actual
 * serialize/rehydrate behavior - the JSON round-trip, the loader reconstruction - that types alone cannot prove.
 */

const COORDS = {
    owner: "acme",
    repo: "storefront",
    installationId: 42,
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
};

const RECIPE: ReporterScenarioRecipe = {
    id: "scn-1",
    name: "Seeded orders",
    description: "Three paid orders for the checkout suite",
    recipe: "INSERT INTO orders ...",
};

/** Every serializable field populated, so a dropped one shows up as a round-trip inequality. */
const SOURCE: ReporterInput = {
    appSlug: "storefront",
    target: { kind: "pull_request", prNumber: 1234, prTitle: "Speed up checkout", prBody: "Debounces submit." },
    range: { baseSha: COORDS.baseSha, headSha: COORDS.headSha },
    impactReasoning: "The diff touches checkout, so its flows were selected.",
    findings: [
        {
            slug: "checkout-happy-path",
            category: "client_bug",
            headline: "Checkout hung at payment",
            expectedBehavior: "The order confirms",
            actualBehavior: "The spinner never resolved",
            whatHappened: "Payment call returned 500",
            selfHealed: true,
            plan: "1. Log in\n2. Check out",
            observedAppIssues: "500 on POST /api/pay",
            falsePositiveRisk: "low",
            codeEvidence: [
                { source: "code", detail: "handler throws", file: "src/pay.ts", lines: "10-12", snippet: "throw err" },
            ],
            screenshots: [
                {
                    assetId: "checkout-happy-path::key",
                    s3Key: "shots/key.png",
                    label: "key frame",
                    pin: { x: 10, y: 20, role: "click" },
                },
            ],
        },
    ],
    branchTests: [
        {
            slug: "login",
            name: "Login",
            category: "passed",
            checkedThisRun: false,
            attributedToClientIssue: false,
            headline: "Logged in as the seeded user",
            fromSha: "a1b2c3d",
        },
    ],
    existingIssues: [
        {
            id: "iss-1",
            title: "Payment fails at checkout",
            kind: "bug",
            severity: "high",
            status: "open",
            expectedBehavior: "Payment succeeds",
            actualBehavior: "Payment 500s",
            narrativeSummary: "Open since abc123",
            findingSlugs: ["checkout-happy-path"],
        },
    ],
    priorReports: [{ snapshotId: "snap-prev", reportMarkdown: "The prior run verified login." }],
    scenarioIndex: [{ id: "scn-1", name: "Seeded orders", summary: "Three paid orders" }],
    codebase: new Codebase("/tmp/source-not-read-in-this-test"),
    // The screenshot loader is dropped by serialize and rebuilt from storage by rehydrate, so the fixture needs
    // none of its own; leaving it unset keeps the fixture free of the evolving Screenshot shape.
    screenshotLoader: undefined,
    scenarioLoader: { loadRecipe: async (id) => (id === RECIPE.id ? RECIPE : undefined) },
};

/** A typed no-op storage - `rehydrateReporterInput` only constructs a loader over it; the methods never run here. */
const UNUSED_STORAGE: StorageProvider = {
    upload: async () => "",
    uploadStream: async () => "",
    download: async () => Buffer.alloc(0),
    delete: async () => {},
    getSignedUrl: async () => "",
};

/** Freeze, serialize to JSON and back, then reparse and rehydrate - exactly what capture then the eval do. */
async function throughDisk(input: ReporterInput): Promise<ReporterInput> {
    const payload = await serializeReporterInput(input);
    const parsed = reporterCaseInputSchema.parse(JSON.parse(JSON.stringify({ codebase: COORDS, ...payload })));
    return rehydrateReporterInput(parsed, new Codebase("/tmp/rehydrated-clone"), UNUSED_STORAGE);
}

describe("reporter eval case round-trip", () => {
    it("preserves every nested data field through a freeze and a rehydrate", async () => {
        const out = await throughDisk(SOURCE);

        expect(out.appSlug).toBe(SOURCE.appSlug);
        expect(out.target).toEqual(SOURCE.target);
        expect(out.range).toEqual(SOURCE.range);
        expect(out.impactReasoning).toBe(SOURCE.impactReasoning);
        expect(out.findings).toEqual(SOURCE.findings);
        expect(out.branchTests).toEqual(SOURCE.branchTests);
        expect(out.existingIssues).toEqual(SOURCE.existingIssues);
        expect(out.priorReports).toEqual(SOURCE.priorReports);
        expect(out.scenarioIndex).toEqual(SOURCE.scenarioIndex);
    });

    it("rebuilds read_scenario as a pure lookup over the frozen recipes", async () => {
        const out = await throughDisk(SOURCE);

        expect(await out.scenarioLoader?.loadRecipe("scn-1")).toEqual(RECIPE);
        expect(await out.scenarioLoader?.loadRecipe("unknown")).toBeUndefined();
    });

    it("offers no scenario loader when the run had no scenarios", async () => {
        const out = await throughDisk({ ...SOURCE, scenarioIndex: [], scenarioLoader: undefined });

        expect(out.scenarioLoader).toBeUndefined();
    });

    // Drives the ACTUAL committed case file through the real schema + rehydrate, so the example a teammate can open
    // is proven to reconstruct - not just an in-memory fixture. Skips in the public mirror, where the case is stripped.
    it.skipIf(!existsSync(EXAMPLE_CASE))("reconstructs the committed example case from disk", async () => {
        const parsed = reporterCaseInputSchema.parse(JSON.parse(readFileSync(EXAMPLE_CASE, "utf8")));
        const out = rehydrateReporterInput(parsed, new Codebase("/tmp/example-clone"), UNUSED_STORAGE);

        expect(out.findings.length).toBeGreaterThan(0);
        expect(out.branchTests.length).toBeGreaterThan(0);
        const [scenario] = out.scenarioIndex;
        if (scenario != null) {
            expect(await out.scenarioLoader?.loadRecipe(scenario.id)).toBeDefined();
        }
    });
});
