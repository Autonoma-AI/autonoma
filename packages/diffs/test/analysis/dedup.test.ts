import type { AnalysisTestOrigin, AnalysisVerdict } from "@autonoma/types";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";
import { type AnalysisFinding, dedupeAnalysisFindings } from "../../src/analysis/dedup";

/** A model that returns the given clusters as the structured dedup output. */
function clustersModel(
    clusters: Array<{ memberSlugs: string[]; headline: string; reason: string }>,
): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        doGenerate: async () => ({
            content: [{ type: "text", text: JSON.stringify({ clusters }) }],
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
                inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 20, text: 20, reasoning: 0 },
            },
            warnings: [],
        }),
    });
}

/** A model that always errors - stands in for a provider failure. */
function failingModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        doGenerate: async () => {
            throw new Error("model exploded");
        },
    });
}

function finding(
    slug: string,
    category: AnalysisVerdict,
    headline = `${slug} headline`,
    planEdited = false,
    origin: AnalysisTestOrigin = "pre_existing",
): AnalysisFinding {
    return { slug, category, headline, planEdited, origin };
}

describe("dedupeAnalysisFindings", () => {
    it("returns the sole finding un-merged without calling the model when there is only one", async () => {
        const model = failingModel();
        const result = await dedupeAnalysisFindings({ findings: [finding("login", "client_bug")], model });

        expect(model.doGenerateCalls).toHaveLength(0);
        expect(result).toEqual([
            {
                category: "client_bug",
                headline: "login headline",
                coveredSlugs: ["login"],
                members: [finding("login", "client_bug")],
            },
        ]);
    });

    it("merges tests that share a cause, unioning their evidence and preserving order", async () => {
        const findings = [
            finding("login", "client_bug"),
            finding("checkout", "client_bug"),
            finding("profile", "passed"),
        ];
        const model = clustersModel([
            { memberSlugs: ["login", "checkout"], headline: "Auth service 500s", reason: "same broken endpoint" },
        ]);

        const result = await dedupeAnalysisFindings({ findings, model });

        expect(result).toHaveLength(2);
        // The merged finding sits where its first member (login) appeared.
        expect(result[0]).toEqual({
            category: "client_bug",
            headline: "Auth service 500s",
            coveredSlugs: ["login", "checkout"],
            members: [finding("login", "client_bug"), finding("checkout", "client_bug")],
        });
        // The un-clustered finding passes through as a singleton.
        expect(result[1]?.coveredSlugs).toEqual(["profile"]);
        expect(result[1]?.category).toBe("passed");
    });

    it("never merges across categories - a mixed cluster splits and cannot escalate to client_bug", async () => {
        // The dangerous mode: one flaky client_bug proposed into a group of non-bug findings. The mixed cluster
        // must SPLIT so the lone client_bug stays a singleton and never relabels the rest of the group.
        const findings = [finding("a", "passed"), finding("b", "client_bug")];
        const model = clustersModel([{ memberSlugs: ["a", "b"], headline: "Shared defect", reason: "same cause" }]);

        const result = await dedupeAnalysisFindings({ findings, model });

        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({ category: "passed", coveredSlugs: ["a"] });
        expect(result[1]).toMatchObject({ category: "client_bug", coveredSlugs: ["b"] });
    });

    it("splits a mixed cluster by category, merging each same-category sub-group on its own", async () => {
        // Two delete findings + one client_bug proposed as one cluster: the deletes merge (their sub-group keeps
        // the anchor's own headline - the model's headline described the full mixed cluster, which did not
        // survive), while the client_bug stands alone.
        const findings = [finding("stale-a", "delete"), finding("bug", "client_bug"), finding("stale-b", "delete")];
        const model = clustersModel([
            { memberSlugs: ["stale-a", "bug", "stale-b"], headline: "One big issue", reason: "same area" },
        ]);

        const result = await dedupeAnalysisFindings({ findings, model });

        expect(result).toHaveLength(2);
        expect(result[0]).toMatchObject({
            category: "delete",
            headline: "stale-a headline",
            coveredSlugs: ["stale-a", "stale-b"],
        });
        expect(result[1]).toMatchObject({ category: "client_bug", coveredSlugs: ["bug"] });
    });

    it("drops hallucinated slugs and clusters that fall below two members", async () => {
        const findings = [finding("login", "client_bug"), finding("home", "passed")];
        const model = clustersModel([
            { memberSlugs: ["login", "ghost"], headline: "phantom merge", reason: "ghost is not real" },
            { memberSlugs: ["home"], headline: "singleton cluster", reason: "only one member" },
        ]);

        const result = await dedupeAnalysisFindings({ findings, model });

        // Neither cluster survives validation, so both findings stand alone.
        expect(result).toHaveLength(2);
        expect(result.every((f) => f.coveredSlugs.length === 1)).toBe(true);
    });

    it("partitions findings across clusters - a slug claimed once is not claimed again", async () => {
        const findings = [finding("a", "client_bug"), finding("b", "client_bug"), finding("c", "client_bug")];
        const model = clustersModel([
            { memberSlugs: ["a", "b"], headline: "first group", reason: "shared" },
            { memberSlugs: ["b", "c"], headline: "second group", reason: "reuses b" },
        ]);

        const result = await dedupeAnalysisFindings({ findings, model });

        // b is claimed by the first cluster, leaving the second with only c (below two members) - dropped.
        expect(result).toHaveLength(2);
        expect(result[0]?.coveredSlugs).toEqual(["a", "b"]);
        expect(result[1]?.coveredSlugs).toEqual(["c"]);
    });

    it("contains a model failure and reports every finding un-merged", async () => {
        const findings = [finding("a", "client_bug"), finding("b", "passed"), finding("c", "client_bug")];

        const result = await dedupeAnalysisFindings({ findings, model: failingModel() });

        expect(result).toHaveLength(3);
        expect(result.map((f) => f.coveredSlugs)).toEqual([["a"], ["b"], ["c"]]);
    });

    it("keeps a same-category merge intact and uses the model's headline for it", async () => {
        const findings = [finding("a", "engine_artifact"), finding("b", "engine_artifact")];
        const model = clustersModel([
            { memberSlugs: ["a", "b"], headline: "shared infra fault", reason: "same cause" },
        ]);

        const result = await dedupeAnalysisFindings({ findings, model });

        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            category: "engine_artifact",
            headline: "shared infra fault",
            coveredSlugs: ["a", "b"],
        });
    });

    it("preserves each member's planEdited through a merge", async () => {
        const findings = [
            finding("a", "client_bug", "a headline", true),
            finding("b", "client_bug", "b headline", false),
        ];
        const model = clustersModel([{ memberSlugs: ["a", "b"], headline: "one defect", reason: "same cause" }]);

        const result = await dedupeAnalysisFindings({ findings, model });

        expect(result).toHaveLength(1);
        expect(result[0]?.members.map((m) => ({ slug: m.slug, planEdited: m.planEdited }))).toEqual([
            { slug: "a", planEdited: true },
            { slug: "b", planEdited: false },
        ]);
    });
});
