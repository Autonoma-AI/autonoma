import type { InvestigationDeployedComparison, InvestigationFinding, InvestigationReportData } from "@autonoma/types";
import { diffLines } from "diff";
import type { DeployedAgentComparison } from "../db/deployed-comparison";
import type { InvestigationReportInput, ReportableVerdict, TestReport } from "./markdown";

/** Category we tag a test section with when the model failed to produce a verdict for it. */
const CLASSIFICATION_ERROR = "classification_error";

/** A unified diff (no code fences) of a proposed test-plan change - the ready-to-render form for the UI. */
function planDiff(original: string, suggested: string): string {
    const before = original.trim() === "" ? "(no existing plan)\n" : original;
    const lines: string[] = [];
    for (const part of diffLines(before, suggested)) {
        const prefix = part.added ? "+" : part.removed ? "-" : " ";
        for (const line of part.value.replace(/\n$/, "").split("\n")) {
            lines.push(`${prefix}${line}`);
        }
    }
    return lines.join("\n");
}

/** Map one classified verdict to a UI finding (media stays s3:// here - the API signs it on read). */
function findingFromVerdict(id: string, test: TestReport, verdict: ReportableVerdict): InvestigationFinding {
    return {
        id,
        slug: test.slug,
        category: verdict.category,
        confidence: verdict.confidence,
        planFidelity: verdict.planFidelity,
        headline: verdict.headline,
        whatHappened: verdict.whatHappened,
        observedAppIssues: verdict.observedAppIssues,
        remediation: verdict.remediation,
        rootCause: verdict.rootCause,
        falsePositiveRisk: verdict.falsePositiveRisk,
        suggestedFixDiff:
            verdict.suggestedTestUpdate != null && verdict.suggestedTestUpdate !== ""
                ? planDiff(test.plan, verdict.suggestedTestUpdate)
                : undefined,
        evidence: verdict.evidence.map((item) => ({
            source: item.source,
            detail: item.detail,
            file: item.file,
            lines: item.lines,
            snippet: item.snippet,
        })),
        plan: test.plan,
        runSuccess: test.runSuccess,
        stepCount: test.stepCount,
        runSteps: test.runSteps,
        videoUrl: test.videoUrl,
        finalScreenshotUrl: test.finalScreenshotUrl,
    };
}

function findingFromError(id: string, test: TestReport, error: string | undefined): InvestigationFinding {
    return {
        id,
        slug: test.slug,
        category: CLASSIFICATION_ERROR,
        headline: `${test.slug} - classification error`,
        error: error ?? "(no verdict)",
        evidence: [],
        plan: test.plan,
        runSuccess: test.runSuccess,
        stepCount: test.stepCount,
        runSteps: test.runSteps,
        videoUrl: test.videoUrl,
        finalScreenshotUrl: test.finalScreenshotUrl,
    };
}

function mapDeployed(deployed: DeployedAgentComparison): InvestigationDeployedComparison {
    return {
        found: deployed.found,
        jobStatus: deployed.jobStatus,
        analysisReasoning: deployed.analysisReasoning,
        resolutionReasoning: deployed.resolutionReasoning,
        failureReason: deployed.failureReason,
        perTest: deployed.perTest.map((test) => ({
            testSlug: test.testSlug,
            affectedReason: test.affectedReason,
            runStatus: test.runStatus,
            generatedFix: test.generatedFix,
        })),
    };
}

/**
 * Project the structured report input (the same object that renders the markdown) into the UI-facing report
 * contract. Each test's verdicts become flat `findings` with stable ids (the slug, suffixed on collision) so
 * the UI can route to one finding. This is the source-of-truth path: the worker persists the result as JSON.
 */
export function buildReportData(input: InvestigationReportInput): InvestigationReportData {
    const findings: InvestigationFinding[] = [];
    const slugCounts = new Map<string, number>();
    for (const test of input.tests) {
        for (const entry of test.verdicts) {
            const seen = (slugCounts.get(test.slug) ?? 0) + 1;
            slugCounts.set(test.slug, seen);
            const id = seen === 1 ? test.slug : `${test.slug}-${seen}`;
            findings.push(
                entry.verdict != null
                    ? findingFromVerdict(id, test, entry.verdict)
                    : findingFromError(id, test, entry.error),
            );
        }
    }
    return {
        client: input.client,
        appSlug: input.appSlug,
        prNumber: input.prNumber,
        prTitle: input.prTitle,
        prBody: input.prBody,
        repoFullName: input.repoFullName,
        commitSha: input.commitSha,
        findings,
        suggested: input.suggested.map((test) => ({
            name: test.name,
            instruction: test.instruction,
            reasoning: test.reasoning,
            validation: test.validation,
        })),
        quarantine: input.quarantine.map((item) => ({ slug: item.slug, reason: item.reason })),
        deployed: mapDeployed(input.deployed),
    };
}
