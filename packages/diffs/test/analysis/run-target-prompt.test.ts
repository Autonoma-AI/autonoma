import type { AnalysisRunTarget } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { buildRunIntentSection, describeRunTarget } from "../../src/analysis/classify/prompt";
import { buildReporterPrompt } from "../../src/analysis/report/prompt";
import type { ReporterInput } from "../../src/analysis/report/types";
import { Codebase } from "../../src/codebase";

const PR_TARGET: AnalysisRunTarget = {
    kind: "pull_request",
    prNumber: 42,
    prTitle: "Rename the checkout total",
    prBody: "Renames the label.",
};
const MAIN_TARGET: AnalysisRunTarget = { kind: "main_branch", branchName: "main" };

function reporterInput(target: AnalysisRunTarget): ReporterInput {
    return {
        appSlug: "acme",
        target,
        range: { baseSha: "aaaa111", headSha: "bbbb222" },
        findings: [],
        branchTests: [],
        existingIssues: [],
        priorReports: [],
        scenarioIndex: [],
        // The prompt builder never reads the checkout - only the tools the agent would call do.
        codebase: new Codebase("/tmp/run-target-prompt-test"),
    };
}

function reporterPromptText(target: AnalysisRunTarget): string {
    const [message] = buildReporterPrompt(reporterInput(target));
    if (message == null || typeof message.content !== "string") throw new Error("expected one text user message");
    return message.content;
}

/**
 * A main-branch run has no PR, and 0 is a preview environment's identity - never a stand-in for one. These assert
 * the prompts say what the run actually is: a rendered `PR #0` invites the agent to reason about, and attribute a
 * bug to, a pull request that does not exist.
 */
describe("run-target rendering", () => {
    it("names a PR by its number and carries the author's stated intent", () => {
        expect(describeRunTarget(PR_TARGET)).toBe("PR #42");

        const intent = buildRunIntentSection(PR_TARGET);
        expect(intent).toContain("PR INTENT");
        expect(intent).toContain("Rename the checkout total");
        expect(intent).toContain("Renames the label.");
    });

    it("names the main branch and states that no PR intent exists", () => {
        expect(describeRunTarget(MAIN_TARGET)).toBe("Main branch `main`");

        const intent = buildRunIntentSection(MAIN_TARGET);
        expect(intent).toContain("MAIN-BRANCH RUN");
        expect(intent).toContain("no pull request and no author-stated");
        expect(intent).not.toContain("PR #");
    });

    it("headers the reporter prompt with the PR for a PR run", () => {
        expect(reporterPromptText(PR_TARGET)).toContain("# PR #42 (acme)");
    });

    it("headers the reporter prompt with the branch, never PR #0, for a main run", () => {
        const prompt = reporterPromptText(MAIN_TARGET);
        expect(prompt).toContain("# Main branch `main` (acme)");
        expect(prompt).not.toContain("PR #");
    });
});
