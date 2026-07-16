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

function finding(slug: string, category: string, headline = `${slug} headline`): AnalysisFinding {
    return { slug, category, headline };
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

    it("raises the merged category to client_bug when any member is a client bug", async () => {
        const findings = [finding("a", "passed"), finding("b", "client_bug")];
        const model = clustersModel([{ memberSlugs: ["a", "b"], headline: "Shared defect", reason: "same cause" }]);

        const result = await dedupeAnalysisFindings({ findings, model });

        expect(result).toHaveLength(1);
        expect(result[0]?.category).toBe("client_bug");
        expect(result[0]?.coveredSlugs).toEqual(["a", "b"]);
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
});
