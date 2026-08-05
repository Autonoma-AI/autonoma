import type { SuiteHealthFixBranch, SuiteHealthFixCluster } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import {
    type SuiteHealthFixPromptInput,
    suiteHealthFixPrompt,
} from "../../src/routes/applications/suite-health-fix-prompt";

function branch(overrides: Partial<SuiteHealthFixBranch> = {}): SuiteHealthFixBranch {
    return {
        branchId: "branch_1",
        branchName: "feat/promo-codes",
        state: "open",
        prNumber: 482,
        prTitle: "Add promo code support",
        issues: [],
        issueCount: 3,
        byKind: { bug: 1, environment: 0, scenario: 2 },
        oldestAgeDays: 6,
        ...overrides,
    };
}

function input(overrides: Partial<SuiteHealthFixPromptInput> = {}): SuiteHealthFixPromptInput {
    return {
        level: "degraded",
        repoFullName: "acme/acme-web",
        openPullRequests: [branch()],
        recentlyFailed: [],
        totalIssues: 3,
        byKind: { bug: 1, environment: 0, scenario: 2 },
        oldestAgeDays: 6,
        truncated: false,
        clusters: [],
        ...overrides,
    };
}

function cluster(overrides: Partial<SuiteHealthFixCluster> = {}): SuiteHealthFixCluster {
    return {
        title: "Scenario setup failed: SDK returned HTTP 500",
        kind: "scenario",
        branches: 10,
        openBranches: 2,
        findings: 185,
        ...overrides,
    };
}

describe("suiteHealthFixPrompt", () => {
    it("names the server on the first line", () => {
        const prompt = suiteHealthFixPrompt(input());

        // An agent holding several MCPs cannot resolve a prompt that names none of them, and picks one.
        expect(prompt.split("\n")[0]).toContain("`autonoma`");
    });

    it("leads with the open pull requests, not the oldest work", () => {
        const prompt = suiteHealthFixPrompt(
            input({
                openPullRequests: [branch({ prNumber: 900, prTitle: "Live and blocked" })],
                recentlyFailed: [
                    branch({ branchId: "b2", prNumber: 100, prTitle: "Long since merged", state: "merged" }),
                ],
            }),
        );

        expect(prompt.indexOf("Live and blocked")).toBeLessThan(prompt.indexOf("Long since merged"));
        expect(prompt).toContain("START HERE");
        expect(prompt).toContain("do NOT go fix these");
        expect(prompt).not.toContain("Work oldest first");
    });

    it("tells the agent to fix a shared cause once, with the numbers that justify it", () => {
        const prompt = suiteHealthFixPrompt(input({ clusters: [cluster()] }));

        expect(prompt).toContain("Most of this is probably ONE problem");
        expect(prompt).toContain("10 pull requests, 2 still open - 185 findings");
        expect(prompt).toContain("Do not work these one at a time");
    });

    it("says nothing about shared causes when findings do not actually repeat", () => {
        // centinel-app's issue titles are all distinct; inventing a shared cause there would send the agent
        // hunting for a pattern that is not in the data.
        const prompt = suiteHealthFixPrompt(input({ clusters: [] }));

        expect(prompt).not.toContain("ONE problem");
        expect(prompt).not.toContain("one at a time");
    });

    it("names the repo, the level and the real pull requests", () => {
        const prompt = suiteHealthFixPrompt(input());

        expect(prompt).toContain("SUITE HEALTH: DEGRADED (1/5) for acme/acme-web");
        expect(prompt).toContain("#482 Add promo code support");
        expect(prompt).toContain("3 findings (2 scenario, 1 bug), 6d");
    });

    it("tells the agent how to find the repo when we could not resolve it", () => {
        const prompt = suiteHealthFixPrompt(input({ repoFullName: undefined }));

        expect(prompt).toContain("git remote get-url origin");
        expect(prompt).toContain("list_apps");
    });

    it("explains only the kinds actually present, so it never sends the agent after a fix with no cause", () => {
        const prompt = suiteHealthFixPrompt(input({ byKind: { bug: 0, environment: 4, scenario: 0 } }));

        expect(prompt).toContain("set_secret");
        expect(prompt).not.toContain("update_recipe");
        expect(prompt).not.toContain("Fix it in this repo");
    });

    it("counts every finding on a branch, not just the ones the modal shows", () => {
        // The branch carries 16 findings but only ever renders 4 - counting the rendered ones produced lines
        // reading "16 findings (4 scenario)".
        const prompt = suiteHealthFixPrompt(
            input({
                openPullRequests: [branch({ issueCount: 16, byKind: { bug: 0, environment: 0, scenario: 16 } })],
            }),
        );

        expect(prompt).toContain("16 findings (16 scenario)");
    });

    it("says the count is a floor when the scan was capped", () => {
        const capped = suiteHealthFixPrompt(input({ totalIssues: 200, truncated: true }));
        const exact = suiteHealthFixPrompt(input({ totalIssues: 200 }));

        expect(capped).toContain("At least 200 findings are unresolved");
        expect(exact).toContain("200 findings are unresolved");
        expect(exact).not.toContain("At least");
    });

    it("refuses to let the agent make a run green by silencing a test", () => {
        const prompt = suiteHealthFixPrompt(input());

        expect(prompt).toContain("Do NOT disable, skip or delete a test");
    });

    it("collapses a long branch list rather than dropping the tail silently", () => {
        const many = Array.from({ length: 14 }, (_, index) =>
            branch({ branchId: `branch_${index}`, prNumber: 100 + index }),
        );
        const prompt = suiteHealthFixPrompt(input({ openPullRequests: many }));

        expect(prompt).toContain("+ 4 more");
    });

    it("keeps the reference-only closed list shorter than the open work list", () => {
        const many = (state: SuiteHealthFixBranch["state"]) =>
            Array.from({ length: 9 }, (_, index) =>
                branch({ branchId: `${state}_${index}`, prNumber: 100 + index, state }),
            );
        const prompt = suiteHealthFixPrompt(input({ openPullRequests: many("open"), recentlyFailed: many("merged") }));

        // 9 open all listed; 9 closed capped at 5, so only the closed group collapses.
        expect(prompt).toContain("+ 4 more");
        expect(prompt.match(/\+ \d+ more/g)).toHaveLength(1);
    });
});
