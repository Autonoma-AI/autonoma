import { db } from "@autonoma/db";
import {
    type DeployedAgentComparison,
    DeployedComparison,
    type InvestigationReportInput,
    type ModelVerdict,
    type TestReport,
    buildReportData,
    buildReportMarkdown,
} from "@autonoma/investigation";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type {
    InvestigationTestResult,
    WriteInvestigationReportInput,
    WriteInvestigationReportOutput,
} from "@autonoma/workflow/activities";
import { resolvePrMeta } from "../codebase/pr-meta";
import { resolveSnapshotMeta } from "../codebase/resolve";
import { getStorage } from "../services";

const REPORT_URL_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Build the investigation report (verdicts + the deployed-agent comparison) and upload it to S3. */
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
        quarantine: input.quarantine,
        deployed,
    };

    const key = `investigation/${meta.appSlug}/${snapshotId}.md`;
    // The structured JSON the in-app view consumes - the precise source-of-truth path (the markdown is the
    // human-readable mirror, and the API can still parse it as a fallback for reports written before this).
    const jsonKey = `investigation/${meta.appSlug}/${snapshotId}.json`;
    const storage = getStorage();
    await storage.upload(key, Buffer.from(buildReportMarkdown(reportInput), "utf8"));
    await storage.upload(jsonKey, Buffer.from(JSON.stringify(buildReportData(reportInput)), "utf8"));

    // Persist the S3 KEY (the API signs a fresh URL on read, so the PR-view link never expires), plus quick
    // counts so the PR view can show "N tests, M bugs" without parsing the markdown. Best-effort: the report's
    // value is the S3 markdown, so a DB write failure (e.g. the table not yet migrated in this env) must never
    // sink the report - it just means the PR-view link won't light up until the row exists.
    const clientBugCount = results.filter((result) => result.verdict?.category === "client_bug").length;
    try {
        await db.investigationReport.upsert({
            where: { snapshotId },
            create: {
                snapshotId,
                s3Key: key,
                testCount: results.length,
                clientBugCount,
                organizationId: meta.organizationId,
            },
            update: { s3Key: key, testCount: results.length, clientBugCount },
        });
    } catch (error) {
        logger.warn("Could not persist the investigation report row; report is still in S3", {
            extra: { key },
            err: error,
        });
    }

    const reportUrl = await storage.getSignedUrl(key, REPORT_URL_TTL_SECONDS);
    logger.info("Investigation report written", { extra: { key, testCount: results.length, clientBugCount } });
    return { reportUrl };
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
function toTestReport(result: InvestigationTestResult): TestReport {
    const modelVerdict: ModelVerdict = { model: "investigation", verdict: result.verdict, error: result.error };
    return {
        slug: result.slug,
        plan: result.plan,
        runSuccess: result.runSuccess,
        stepCount: result.stepCount,
        runSteps: result.runSteps,
        verdicts: [modelVerdict],
        videoUrl: result.videoUrl,
        finalScreenshotUrl: result.finalScreenshotUrl,
    };
}
