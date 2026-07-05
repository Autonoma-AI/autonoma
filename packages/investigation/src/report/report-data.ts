import type {
    InvestigationDeployedComparison,
    InvestigationEvidence,
    InvestigationFinding,
    InvestigationReportData,
} from "@autonoma/types";
import { diffLines } from "diff";
import type { DeployedAgentComparison } from "../db/deployed-comparison";
import type {
    InvestigationReportInput,
    ReportableScenarioDiagnosis,
    ReportableSecondaryObservation,
    ReportableVerdict,
    TestReport,
} from "./markdown";

/** Category we tag a test section with when the model failed to produce a verdict for it. */
const CLASSIFICATION_ERROR = "classification_error";

/** Human labels for the scenario-repair diagnoser's route (mirrors the markdown renderer's labels). */
const SCENARIO_ROUTE_LABEL: Record<string, string> = {
    fix_test: "Fix the test",
    recipe_only: "Edit the scenario recipe",
    recipe_and_sdk: "Client factory change needed",
    unknown: "Not a scenario-data problem",
};

/**
 * The scenario-repair diagnosis, as evidence pieces on the finding: the recommended lever (route) + the agent's
 * reasoning, the concrete change it would make (recipe/factory/test edit, with the candidate `create` graph as a
 * code snippet), the autofix outcome, and any give-up handoff. Observe-first: this surfaces WHAT the agent would
 * do, alongside the run's other evidence. Empty when the finding has no scenario diagnosis.
 */
function scenarioDiagnosisEvidence(diagnosis: ReportableScenarioDiagnosis | undefined): InvestigationEvidence[] {
    if (diagnosis == null) return [];
    const label = SCENARIO_ROUTE_LABEL[diagnosis.route] ?? diagnosis.route;
    const evidence: InvestigationEvidence[] = [
        { source: "scenario repair", detail: `${label} (${diagnosis.confidence} confidence): ${diagnosis.reasoning}` },
    ];

    if (diagnosis.testFix != null && diagnosis.testFix !== "") {
        evidence.push({ source: "test fix", detail: diagnosis.testFix });
    }
    if (diagnosis.recipeChange != null && diagnosis.recipeChange !== "") {
        evidence.push({
            source: "recipe change",
            detail: diagnosis.proposedRecipeSummary ?? diagnosis.recipeChange,
            snippet: diagnosis.proposedRecipeCreateGraph,
        });
    }
    if (diagnosis.factoryIssue != null && diagnosis.factoryIssue !== "") {
        evidence.push({ source: "factory change", detail: diagnosis.factoryIssue });
    }
    if (diagnosis.applied != null) {
        const status = diagnosis.applied ? "validated on the twin (branch-scoped)" : "not validated";
        const note = diagnosis.appliedNote != null && diagnosis.appliedNote !== "" ? ` - ${diagnosis.appliedNote}` : "";
        evidence.push({ source: "autofix", detail: `${status}${note}` });
    }
    if (diagnosis.repairHandoff != null && diagnosis.repairHandoff !== "") {
        evidence.push({
            source: "repair handoff",
            detail: "The agent could not produce a factory-accepted recipe - what it tried and what a human must change:",
            snippet: diagnosis.repairHandoff,
        });
    }
    return evidence;
}

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
 * Flatten each test's verdicts into findings with stable ids (the slug, suffixed on collision). This is the
 * shared id authority: the report AND the reconciliation step both build findings this way, so the merge
 * clusters (which reference finding ids) line up with the findings the report persists. Deterministic on
 * `tests`, so calling it twice with the same input yields the same ids.
 */
export function buildFindings(tests: TestReport[]): InvestigationFinding[] {
    const findings: InvestigationFinding[] = [];
    const slugCounts = new Map<string, number>();
    for (const test of tests) {
        // The scenario-repair diagnosis is a single per-test field (mirrors the markdown renderer, which emits it
        // once per test section). Attach it to the FIRST finding for this test only - never per verdict - so a
        // multi-model test doesn't carry N redundant copies of the same recommended lever across its findings.
        const diagnosisEvidence = scenarioDiagnosisEvidence(test.scenarioDiagnosis);
        let firstForTest = true;
        for (const entry of test.verdicts) {
            const seen = (slugCounts.get(test.slug) ?? 0) + 1;
            slugCounts.set(test.slug, seen);
            const id = seen === 1 ? test.slug : `${test.slug}-${seen}`;
            const finding =
                entry.verdict != null
                    ? findingFromVerdict(id, test, entry.verdict)
                    : findingFromError(id, test, entry.error);
            if (firstForTest) {
                finding.evidence.push(...diagnosisEvidence);
                firstForTest = false;
            }
            findings.push(finding);
            // A verdict is one-per-test, but a single run can reveal several unrelated visible defects. Promote each
            // to its OWN finding (id suffixed off the verdict's) so it persists, renders, and reconciles on its own -
            // a bug the test walked past is not hostage to that test's category.
            if (entry.verdict != null) {
                findings.push(...secondaryFindings(id, test, entry.verdict.secondaryObservations));
            }
        }
    }
    return findings;
}

/**
 * Turn a verdict's secondary observations into standalone findings. They reuse the run's media (same recording) but
 * carry their own category/headline and a screenshot-sourced evidence line - the defect is what was SEEN, not a code
 * trace. Ids are the verdict's id suffixed with `-obs-N` so they never collide and can be told apart downstream.
 */
function secondaryFindings(
    primaryId: string,
    test: TestReport,
    observations: ReportableSecondaryObservation[] | undefined,
): InvestigationFinding[] {
    if (observations == null) return [];
    return observations.map((observation, index) => ({
        id: `${primaryId}-obs-${index + 1}`,
        slug: test.slug,
        category: observation.category,
        confidence: observation.confidence,
        headline: observation.headline,
        whatHappened: observation.detail,
        rootCause: observation.detail,
        evidence: [{ source: "screenshot", detail: observation.detail }],
        plan: test.plan,
        runSuccess: test.runSuccess,
        stepCount: test.stepCount,
        runSteps: test.runSteps,
        videoUrl: test.videoUrl,
        finalScreenshotUrl: test.finalScreenshotUrl,
    }));
}

/**
 * Project the structured report input (the same object that renders the markdown) into the UI-facing report
 * contract. Each test's verdicts become flat `findings` with stable ids (the slug, suffixed on collision) so
 * the UI can route to one finding. This is the source-of-truth path: the worker persists the result as JSON.
 */
export function buildReportData(input: InvestigationReportInput): InvestigationReportData {
    const findings = buildFindings(input.tests);
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
        deployed: mapDeployed(input.deployed),
    };
}
