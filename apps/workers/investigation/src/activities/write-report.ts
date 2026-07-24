import { db } from "@autonoma/db";
import {
    type DeployedAgentComparison,
    DeployedComparison,
    InvestigationReportPersister,
    type InvestigationReportInput,
    type ModelVerdict,
    type TestReport,
    applyReconciliation,
    buildReportData,
} from "@autonoma/investigation";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type {
    InvestigationTestResult,
    WriteInvestigationReportInput,
    WriteInvestigationReportOutput,
} from "@autonoma/workflow/activities";
import { resolvePrMeta } from "../codebase/pr-meta";
import { resolveSnapshotMeta } from "../codebase/resolve";

/**
 * Persist the investigation report (verdicts + the deployed-agent comparison) into the queryable island tables.
 * The DB is the single source of truth the in-app view reads back - there is no S3 mirror (neither the old JSON
 * blob nor the markdown): the UI rendering the DB rows IS the human-readable report.
 */
export async function writeInvestigationReport(
    input: WriteInvestigationReportInput,
): Promise<WriteInvestigationReportOutput> {
    const { snapshotId, results } = input;
    const logger = rootLogger.child({
        name: "writeInvestigationReport",
        extra: { snapshotId, testCount: results.length },
    });
    logger.info("Writing investigation report");

    const meta = await resolveSnapshotMeta(snapshotId);
    const prMeta = await resolvePrMeta(meta);
    // The deployed-agent comparison is supplementary - never let it sink the whole report (e.g. a DB
    // migration not yet applied to the env, or a transient query error).
    const deployed = await loadDeployedComparison(meta.headSha, logger);

    const reportInput: InvestigationReportInput = {
        client: meta.clientName,
        appSlug: meta.appSlug,
        prNumber: prMeta.prNumber,
        prTitle: prMeta.prTitle,
        prBody: prMeta.prBody,
        repoFullName: meta.repoFullName,
        commitSha: meta.headSha,
        tests: results.map(toTestReport),
        suggested: input.suggested,
        deployed,
    };

    // Collapse same-issue findings using the reconciliation agent's merges (computed in its own activity): several
    // tests can surface one underlying issue, and this leaves a single enriched finding per issue. A no-op when
    // reconciliation was empty or failed upstream (the workflow passes { merges: [] }).
    const built = buildReportData(reportInput);
    const findings = applyReconciliation(built.findings, input.reconciliation ?? { merges: [] });
    const reportData = { ...built, findings };

    // Persist the structured report into the island tables (upsert parent + replace children in one
    // transaction). This is the deliverable the in-app view consumes; a failure propagates so Temporal retries
    // the report step (unlike the old best-effort S3 write).
    await new InvestigationReportPersister(db).persist({
        snapshotId,
        organizationId: meta.organizationId,
        data: reportData,
    });

    const clientBugCount = reportData.findings.filter((finding) => finding.category === "client_bug").length;
    logger.info("Investigation report written", {
        extra: { testCount: reportData.findings.length, clientBugCount },
    });
    return { testCount: reportData.findings.length, clientBugCount };
}

async function loadDeployedComparison(headSha: string, logger: Logger): Promise<DeployedAgentComparison> {
    try {
        return await new DeployedComparison(db).byHeadSha(headSha);
    } catch (error) {
        logger.warn("Deployed-agent comparison unavailable; rendering report without it", {
            extra: { headSha },
            err: error,
        });
        return { found: false, perTest: [] };
    }
}

/** Map one classified shadow run to the report's per-test section (single "investigation" model column). */
export function toTestReport(result: InvestigationTestResult): TestReport {
    const verdict = result.verdict;
    // The legacy narrative fields are optional on InvestigationVerdict (the analysis path emits expected/actual
    // instead), but this frozen report still requires them; the investigation classifier always fills them, so
    // default only bridges the type gap.
    const modelVerdict: ModelVerdict = {
        model: "investigation",
        verdict:
            verdict == null
                ? undefined
                : {
                      ...verdict,
                      falsePositiveRisk: verdict.falsePositiveRisk ?? "",
                      whatHappened: verdict.whatHappened ?? verdict.actualBehavior ?? "",
                      rootCause: verdict.rootCause ?? "",
                      remediation: verdict.remediation ?? "",
                  },
        error: result.error,
    };
    return {
        slug: result.slug,
        plan: result.plan,
        runSuccess: result.runSuccess,
        stepCount: result.stepCount,
        runSteps: result.runSteps,
        runTrace: result.runTrace,
        verdicts: [modelVerdict],
        videoUrl: result.videoUrl,
        finalScreenshotUrl: result.finalScreenshotUrl,
        scenarioDiagnosis: result.scenarioDiagnosis,
    };
}
