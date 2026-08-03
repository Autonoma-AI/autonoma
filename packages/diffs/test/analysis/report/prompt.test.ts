import type { AnalysisVerdict } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { buildReporterPrompt } from "../../../src/analysis/report/prompt";
import type { ReporterExistingIssue, ReporterFinding, ReporterInput } from "../../../src/analysis/report/types";
import { Codebase } from "../../../src/codebase";

function finding(slug: string, category: AnalysisVerdict, extra: Partial<ReporterFinding> = {}): ReporterFinding {
    return { slug, category, headline: `${slug} headline`, selfHealed: false, screenshots: [], ...extra };
}

function openBugIssue(id: string): ReporterExistingIssue {
    return {
        id,
        title: id,
        kind: "bug",
        severity: "high",
        status: "open",
        actualBehavior: "The button stayed disabled.",
        findingSlugs: ["checkout"],
    };
}

function promptText(findings: ReporterFinding[], existingIssues: ReporterExistingIssue[] = []): string {
    const input: ReporterInput = {
        appSlug: "acme",
        pr: { number: 42, title: "Add coupon codes" },
        range: { baseSha: "aaaaaaa", headSha: "bbbbbbb" },
        findings,
        existingIssues,
        priorReports: [],
        scenarioIndex: [],
        // The prompt never reads the repo - only the tools do - so an unused root is enough.
        codebase: new Codebase("/tmp/reporter-prompt-test"),
    };
    const [message] = buildReporterPrompt(input);
    const content = message?.content;
    return typeof content === "string" ? content : "";
}

describe("buildReporterPrompt - the verdict is handed over, never authored", () => {
    it("states the amber verdict and forbids prose that implies the change is safe", () => {
        const text = promptText([
            finding("checkout", "passed"),
            finding("coupons", "scenario_issue"),
            finding("cart", "engine_artifact"),
        ]);

        expect(text).toContain(
            "3 test(s) investigated this job: 1 confirmed the app, 0 found a bug, 2 check(s) did not complete",
        );
        expect(text).toContain("1 scenario_issue");
        expect(text).toContain("1 engine_artifact");
        expect(text).toContain("this PR reads NOT CONFIRMED");
        // The exact copy every other surface renders, so the prose cannot describe a different run.
        expect(text).toContain("Autonoma couldn't confirm this change - 2 checks didn't complete.");
        expect(text).toContain("The change was NOT fully exercised.");
        expect(text).toContain("Never call the change safe, verified, clean, or good to merge");
    });

    it("leads a clean run with what was verified rather than with the absence of bugs", () => {
        const text = promptText([finding("checkout", "passed"), finding("cart", "passed")]);

        expect(text).toContain("this PR reads HEALTHY");
        expect(text).toContain("Autonoma verified this change - the app held up.");
        expect(text).toContain("Lead with what we verified, concretely");
    });

    it("settles a run whose own test found a bug as red, without quoting a bug count it does not yet own", () => {
        const text = promptText([finding("checkout", "client_bug"), finding("cart", "passed")]);

        // Coverage guarantee 1 forces this finding under an issue, so red really is settled here.
        expect(text).toContain("This PR therefore reads BUG FOUND (red): a test found a bug this job");
        expect(text).toContain("Lead with what breaks for a user");
        expect(text).not.toContain("NOT CONFIRMED");
    });

    it("states BOTH readings for a carried bug the run may resolve, rather than calling red settled", () => {
        const text = promptText([finding("cart", "passed")], [openBugIssue("issue_place_order")]);

        expect(text).toContain("Open bug issue(s) carried from earlier runs on this branch: 1.");
        // Resolving is what a passing covering test requires, so the prompt must not claim the verdict is settled -
        // that would both mis-state the outcome and discourage the resolve.
        expect(text).not.toContain("settled");
        expect(text).toContain("leave the carried bug issue(s) open and the PR reads BUG FOUND (red)");
        expect(text).toContain("resolve them");
        expect(text).toContain('it reads HEALTHY, headline: "Autonoma verified this change - the app held up."');
        // And a rule for each branch, so whichever way it reconciles, the prose has one to follow.
        expect(text).toContain("If it stays red: Lead with what breaks for a user");
        expect(text).toContain("If you resolve it: Every affected test ran and confirmed the app.");
    });

    it("says plainly that nothing was exercised when the run investigated no test", () => {
        const text = promptText([]);

        expect(text).toContain("this PR reads NO TESTS AFFECTED");
        expect(text).toContain("no evidence either way");
    });

    it("shows a coverage finding's account of the fault, which is where an env gap's owner is readable", () => {
        const text = promptText([
            finding("invoices", "environment_failure", {
                whatHappened: "The preview served a 500 because the Firestore index the invoice query needs is absent.",
            }),
        ]);

        expect(text).toContain(
            "What happened: The preview served a 500 because the Firestore index the invoice query needs is absent.",
        );
    });
});
