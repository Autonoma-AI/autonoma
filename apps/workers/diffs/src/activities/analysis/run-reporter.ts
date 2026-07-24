import { db } from "@autonoma/db";
import { StorageEvidenceLoader, resolveScenarioRecipesForSnapshot, summarizeScenarioRecipes } from "@autonoma/diffs";
import {
    type CoverageSummary,
    ReporterAgent,
    type ReporterEvidenceAsset,
    type ReporterExistingIssue,
    type ReporterFinding,
    type ReporterInput,
    type ReporterIssueResult,
    type ReporterPriorReport,
    type ReporterResult,
    type ReporterScenarioLoader,
    type ReporterScenarioSummary,
    persistInvestigationCosts,
    reporterIssueKindSchema,
    reporterIssueSeveritySchema,
    reporterIssueStatusSchema,
    summarizeVerdictPlanes,
    type VerdictPlaneFinding,
} from "@autonoma/diffs/analysis";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { fetchTestSuiteInfo } from "@autonoma/test-updates";
import { ANALYSIS_VERDICT, analysisVerdictSchema } from "@autonoma/types";
import type { RunReporterInput, RunReporterOutput } from "@autonoma/workflow/activities";
import { resolvePrMeta } from "../../codebase/pr-meta";
import { type SnapshotContext, withSnapshotContext } from "../../codebase/snapshot-context";
import { createModelSession, getStorage } from "../../services";
import { uploadConversation } from "../../upload-conversation";

/** How many prior branch reports to carry as cumulative context. */
const PRIOR_REPORTS_LIMIT = 3;
/** How much of an existing issue's narrative to show as its cross-time matching summary. */
const NARRATIVE_SUMMARY_CHARS = 240;
/** Cap on how many run-trace step frames a finding offers as fetchable evidence (the key frame is always offered). */
const MAX_TRACE_SCREENSHOTS = 20;

/** The interactive-transaction client - also satisfied by the full `db`, so report writes share one helper. */
type PrismaWriteClient = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/**
 * How the Reporter's result is produced. Injected so tests exercise the persistence + failure paths with a canned
 * result (no clone, no model); the default clones the snapshot's repo and runs the real ReporterAgent inside it.
 */
export type ReporterResultProducer = (input: RunReporterInput) => Promise<ReporterResult>;

export interface RunReporterDeps {
    produceResult?: ReporterResultProducer;
}

/**
 * Reporter stage - reconciles the findings the Investigators persisted this run (plus the branch's evolving issues +
 * prior reports) into branch-scoped AnalysisIssues (open / carry-forward / resolve), backfills each finding's
 * `issueId`, derives the run's verdict + counts, and creates the AnalysisReport - all in one transaction. The
 * report is born here and nowhere else, so its existence means the Reporter ran; a failure here fails the run.
 */
export async function runReporter(input: RunReporterInput, deps: RunReporterDeps = {}): Promise<RunReporterOutput> {
    const { snapshotId, impactReasoning } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "runReporter" });
    logger.info("Reporter stage started");

    const produce = deps.produceResult ?? produceReporterResult;
    const result = await produce(input);
    const output = await persistReporterResult(snapshotId, result, impactReasoning, logger);
    logger.info("Reporter stage finished", { extra: output });
    return output;
}

/** The default producer: clone the snapshot's repo and run the real ReporterAgent inside it. */
async function produceReporterResult(input: RunReporterInput): Promise<ReporterResult> {
    const { snapshotId } = input;
    return withSnapshotContext(snapshotId, `reporter-${snapshotId}`, async (context) => {
        const logger = rootLogger.child({ name: "produceReporterResult" });
        const reporterInput = await buildReporterInput(input, context, logger);

        const session = createModelSession();
        const agent = new ReporterAgent({ model: session.getModel({ model: "reporter", tag: "analysis-reporter" }) });
        const { result, conversation } = await agent.run(reporterInput);

        // Both auxiliary writes are best-effort - a failure of either must not discard the report we just produced.
        await Promise.all([
            uploadConversation({
                storage: getStorage(),
                snapshotId,
                phase: "reporter",
                conversation,
                logger: logger.child({ name: "uploadConversation" }),
            }).catch((error) => logger.warn("Failed to upload reporter conversation", { err: error })),
            persistInvestigationCosts(db, snapshotId, session.costCollector, logger).catch((error) =>
                logger.warn("Failed to persist reporter costs", { err: error }),
            ),
        ]);
        return result;
    });
}

/** Assemble the Reporter's input from the run's persisted findings + the branch's issue/report history + deps. */
async function buildReporterInput(
    input: RunReporterInput,
    context: SnapshotContext,
    logger: Logger,
): Promise<ReporterInput> {
    const { snapshotId, impactReasoning } = input;
    const [prMeta, findings, existingIssues, priorReports, scenario] = await Promise.all([
        resolvePrMeta(context),
        loadReporterFindings(snapshotId),
        loadExistingIssues(context.branchId, logger),
        loadPriorReports(snapshotId, context.branchId),
        loadScenarioContext(snapshotId, logger),
    ]);

    return {
        appSlug: context.appSlug,
        pr: { number: prMeta.prNumber, title: prMeta.prTitle, body: prMeta.prBody },
        impactReasoning,
        findings,
        existingIssues,
        priorReports,
        scenarioIndex: scenario.index,
        codebase: context.codebase,
        screenshotLoader: new StorageEvidenceLoader(getStorage()),
        scenarioLoader: scenario.loader,
    };
}

/** Load this run's persisted findings and shape each into what the Reporter reasons over (incl. fetchable frames). */
async function loadReporterFindings(snapshotId: string): Promise<ReporterFinding[]> {
    const rows = await db.analysisFinding.findMany({
        where: { reportSnapshotId: snapshotId },
        orderBy: { displayOrder: "asc" },
        select: {
            slug: true,
            category: true,
            headline: true,
            expectedBehavior: true,
            actualBehavior: true,
            planEdited: true,
            selfHealNote: true,
            plan: true,
            observedAppIssues: true,
            falsePositiveRisk: true,
            evidence: true,
            screenshotKey: true,
            runTrace: true,
        },
    });

    return rows.map((row) => ({
        slug: row.slug,
        category: analysisVerdict(row.category),
        headline: row.headline,
        expectedBehavior: row.expectedBehavior ?? undefined,
        actualBehavior: row.actualBehavior ?? undefined,
        planEdited: row.planEdited ?? false,
        selfHealNote: row.selfHealNote ?? undefined,
        plan: row.plan ?? undefined,
        observedAppIssues: row.observedAppIssues ?? undefined,
        falsePositiveRisk: row.falsePositiveRisk ?? undefined,
        codeEvidence: row.evidence ?? undefined,
        screenshots: buildScreenshots(row.slug, row.screenshotKey, row.runTrace),
    }));
}

/** The fetchable screenshots for one finding: its classifier key frame plus a bounded slice of trace frames. */
function buildScreenshots(
    slug: string,
    screenshotKey: string | null,
    runTrace: PrismaJson.InvestigationRunTrace | null,
): ReporterEvidenceAsset[] {
    const assets: ReporterEvidenceAsset[] = [];
    if (screenshotKey != null) assets.push({ assetId: `${slug}::key`, s3Key: screenshotKey, label: "key frame" });

    let traceCount = 0;
    for (const step of runTrace ?? []) {
        if (step.screenshotUrl == null || traceCount >= MAX_TRACE_SCREENSHOTS) continue;
        traceCount += 1;
        const label = `step ${step.order} (${step.interaction})`;
        const asset: ReporterEvidenceAsset = {
            assetId: `${slug}::step-${step.order}`,
            s3Key: step.screenshotUrl,
            label,
        };
        if (step.point != null) asset.pin = { x: step.point.x, y: step.point.y, role: "click" };
        assets.push(asset);
    }
    return assets;
}

/** Load the branch's issues (open + resolved) the Reporter reconciles against, skipping any malformed row. */
async function loadExistingIssues(branchId: string, logger: Logger): Promise<ReporterExistingIssue[]> {
    const rows = await db.analysisIssue.findMany({
        where: { branchId },
        orderBy: { updatedAt: "desc" },
        select: {
            id: true,
            title: true,
            kind: true,
            severity: true,
            status: true,
            expectedBehavior: true,
            actualBehavior: true,
            narrativeMarkdown: true,
            findingSlugs: true,
        },
    });

    const issues: ReporterExistingIssue[] = [];
    for (const row of rows) {
        const kind = reporterIssueKindSchema.safeParse(row.kind);
        const severity = reporterIssueSeveritySchema.safeParse(row.severity);
        const status = reporterIssueStatusSchema.safeParse(row.status);
        if (!kind.success || !severity.success || !status.success) {
            logger.warn("Skipping malformed AnalysisIssue while building reporter input", { extra: { id: row.id } });
            continue;
        }
        issues.push({
            id: row.id,
            title: row.title,
            kind: kind.data,
            severity: severity.data,
            status: status.data,
            expectedBehavior: row.expectedBehavior ?? undefined,
            actualBehavior: row.actualBehavior,
            narrativeSummary: truncate(row.narrativeMarkdown, NARRATIVE_SUMMARY_CHARS),
            findingSlugs: row.findingSlugs,
        });
    }
    return issues;
}

/** The branch's most recent prior reports (excluding this snapshot) so the Reporter writes a cumulative narrative. */
async function loadPriorReports(snapshotId: string, branchId: string): Promise<ReporterPriorReport[]> {
    const rows = await db.analysisReport.findMany({
        where: { snapshot: { branchId }, reportMarkdown: { not: null }, NOT: { snapshotId } },
        orderBy: { createdAt: "desc" },
        take: PRIOR_REPORTS_LIMIT,
        select: { snapshotId: true, reportMarkdown: true },
    });
    return rows.flatMap((row) =>
        row.reportMarkdown != null ? [{ snapshotId: row.snapshotId, reportMarkdown: row.reportMarkdown }] : [],
    );
}

interface ScenarioContext {
    index: ReporterScenarioSummary[];
    loader?: ReporterScenarioLoader;
}

/**
 * Build the light scenario index + on-demand recipe loader for the run's suite. Best-effort: a scenario-load
 * failure degrades to an empty index (the Reporter's read_scenario tool is simply not offered), never sinks it.
 */
async function loadScenarioContext(snapshotId: string, logger: Logger): Promise<ScenarioContext> {
    try {
        const suiteInfo = await fetchTestSuiteInfo(db, snapshotId);
        const scenarioIds = collectScenarioIds(suiteInfo);
        if (scenarioIds.length === 0) return { index: [] };

        const recipes = await resolveScenarioRecipesForSnapshot(db, snapshotId, scenarioIds);
        if (recipes.length === 0) return { index: [] };

        const byId = new Map(recipes.map((recipe) => [recipe.scenarioId, recipe]));
        const index: ReporterScenarioSummary[] = recipes.map((recipe) => ({
            id: recipe.scenarioId,
            name: recipe.scenarioName,
            summary: recipe.description ?? "Seeds test data for this scenario.",
        }));
        const loader: ReporterScenarioLoader = {
            loadRecipe: async (scenarioId) => {
                const recipe = byId.get(scenarioId);
                if (recipe == null) return undefined;
                return {
                    id: recipe.scenarioId,
                    name: recipe.scenarioName,
                    description: recipe.description,
                    recipe: summarizeScenarioRecipes([recipe]) ?? recipe.description ?? "",
                };
            },
        };
        return { index, loader };
    } catch (error) {
        logger.warn("Failed to load scenario context for the reporter; continuing without it", { err: error });
        return { index: [] };
    }
}

/** The distinct scenario ids the snapshot's suite references. */
function collectScenarioIds(suiteInfo: Awaited<ReturnType<typeof fetchTestSuiteInfo>>): string[] {
    const ids = new Set<string>();
    for (const testCase of suiteInfo.testCases) {
        const scenarioId = testCase.plan?.scenarioId;
        if (scenarioId != null) ids.add(scenarioId);
    }
    return [...ids];
}

/**
 * Persist the Reporter's result: apply each issue reconciliation (open / carry-forward / resolve), backfill the
 * covered findings' `issueId`, derive the run's verdict + counts, and create the report (prose + header) - all in
 * one transaction so the report, its verdict, and its issues are always consistent. The open-bug-issue count is
 * read inside the transaction, after the reconciliations, so the verdict reflects this run's issue writes.
 */
async function persistReporterResult(
    snapshotId: string,
    result: ReporterResult,
    impactReasoning: string | undefined,
    logger: Logger,
): Promise<RunReporterOutput> {
    const [snapshot, planes] = await Promise.all([
        db.branchSnapshot.findUnique({
            where: { id: snapshotId },
            select: { branchId: true, branch: { select: { organizationId: true } } },
        }),
        loadFindingPlanes(snapshotId),
    ]);
    if (snapshot == null) throw new Error(`Snapshot ${snapshotId} not found; cannot persist the reporter result`);
    const { branchId } = snapshot;
    const organizationId = snapshot.branch.organizationId;

    const output = await db.$transaction(async (tx) => {
        const counts = { issuesOpened: 0, issuesCarried: 0, issuesResolved: 0 };
        for (const issue of result.issues) {
            if (issue.kind === "open") {
                counts.issuesOpened += 1;
            } else if (issue.kind === "carry_forward") {
                counts.issuesCarried += 1;
            } else {
                counts.issuesResolved += 1;
            }
            await applyIssue(tx, issue, { snapshotId, branchId, organizationId });
        }

        const header = deriveReportHeader(planes, await countOpenBugIssues(tx, branchId));
        await writeReport(tx, { snapshotId, organizationId, impactReasoning, header, result });
        return { ...counts, verdict: header.verdict, clientBugCount: header.clientBugCount };
    });

    logger.info("Persisted reporter result", { extra: output });
    return output;
}

interface ReportHeader {
    verdict: string;
    clientBugCount: number;
    testCount: number;
    coverage: CoverageSummary;
}

/**
 * Derive the run's verdict + counts. Coverage summary and test count come from the run's findings; the bug count is
 * the branch's open bug-kind issues (so a bug carried across snapshots keeps the PR red even when no test re-ran
 * it, and resolving flips it green). The verdict is `client_bug` iff the bug count is positive.
 */
function deriveReportHeader(planes: VerdictPlaneFinding[], openBugCount: number): ReportHeader {
    const coverage = summarizeVerdictPlanes(planes).coverage;
    const verdict = openBugCount > 0 ? ANALYSIS_VERDICT.client_bug : ANALYSIS_VERDICT.passed;
    return { verdict, clientBugCount: openBugCount, testCount: planes.length, coverage };
}

interface WriteReportInput {
    snapshotId: string;
    organizationId: string;
    impactReasoning: string | undefined;
    header: ReportHeader;
    result: ReporterResult;
}

/**
 * Create the AnalysisReport. `upsert` keeps the Reporter idempotent - a retry after a committed run updates the row
 * rather than throwing on its `snapshotId` PK.
 */
async function writeReport(tx: PrismaWriteClient, input: WriteReportInput): Promise<void> {
    const reasoning = input.impactReasoning != null && input.impactReasoning !== "" ? input.impactReasoning : undefined;
    const data = {
        organizationId: input.organizationId,
        verdict: input.header.verdict,
        clientBugCount: input.header.clientBugCount,
        testCount: input.header.testCount,
        coverage: input.header.coverage,
        impactReasoning: reasoning,
        reportMarkdown: input.result.reportMarkdown,
        evidenceManifest: input.result.reportEvidenceManifest,
    };
    await tx.analysisReport.upsert({
        where: { snapshotId: input.snapshotId },
        create: { snapshotId: input.snapshotId, ...data },
        update: data,
    });
}

/** This run's findings as the verdict-plane summary reads them (category + the delete-origin tag). */
async function loadFindingPlanes(snapshotId: string): Promise<VerdictPlaneFinding[]> {
    const rows = await db.analysisFinding.findMany({
        where: { reportSnapshotId: snapshotId },
        select: { category: true, origin: true },
    });
    return rows.map((row) => ({ category: row.category, origin: row.origin ?? undefined }));
}

/** The branch's open bug-kind issues - the count that drives the verdict. */
async function countOpenBugIssues(tx: PrismaWriteClient, branchId: string): Promise<number> {
    return await tx.analysisIssue.count({
        where: {
            branchId,
            status: reporterIssueStatusSchema.enum.open,
            kind: reporterIssueKindSchema.enum.bug,
        },
    });
}

interface ApplyIssueIds {
    snapshotId: string;
    branchId: string;
    organizationId: string;
}

/** Apply one reconciliation to the AnalysisIssue store and backfill the covered findings' `issueId`. */
async function applyIssue(tx: PrismaWriteClient, issue: ReporterIssueResult, ids: ApplyIssueIds): Promise<void> {
    if (issue.kind === "resolve") {
        await tx.analysisIssue.update({
            where: { id: issue.existingIssueId },
            data: { status: "resolved", resolvedAt: new Date() },
        });
        return;
    }

    const content = issue.content;
    const data = {
        branchId: ids.branchId,
        organizationId: ids.organizationId,
        title: content.title,
        kind: content.kind,
        severity: content.severity,
        status: "open",
        resolvedAt: null,
        expectedBehavior: content.expectedBehavior,
        actualBehavior: content.actualBehavior,
        narrativeMarkdown: content.narrativeMarkdown,
        evidenceManifest: content.evidenceManifest,
        primaryScreenshot: content.primaryScreenshot,
        suspectedCause: content.suspectedCause,
    };

    if (issue.kind === "open") {
        const created = await tx.analysisIssue.create({
            data: { ...data, findingSlugs: content.findingSlugs },
        });
        await backfillIssueId(tx, ids.snapshotId, content.findingSlugs, created.id);
        return;
    }

    // carry_forward: re-state the issue's content, reopen it if it had been resolved, and union this job's slugs.
    const existing = await tx.analysisIssue.findUnique({
        where: { id: issue.existingIssueId },
        select: { findingSlugs: true },
    });
    const mergedSlugs = unionSlugs(existing?.findingSlugs ?? [], content.findingSlugs);
    await tx.analysisIssue.update({
        where: { id: issue.existingIssueId },
        data: { ...data, findingSlugs: mergedSlugs },
    });
    await backfillIssueId(tx, ids.snapshotId, content.findingSlugs, issue.existingIssueId);
}

/** Attribute this run's covered findings to their issue (only rows on this snapshot; other snapshots keep theirs). */
async function backfillIssueId(
    tx: PrismaWriteClient,
    snapshotId: string,
    findingSlugs: string[],
    issueId: string,
): Promise<void> {
    if (findingSlugs.length === 0) return;
    await tx.analysisFinding.updateMany({
        where: { reportSnapshotId: snapshotId, slug: { in: findingSlugs } },
        data: { issueId },
    });
}

function unionSlugs(existing: string[], added: string[]): string[] {
    return [...new Set([...existing, ...added])];
}

/** The stored `category` is a plain string; keep the finding's terminal verdict as-is for the Reporter to reason. */
function analysisVerdict(category: string): ReporterFinding["category"] {
    return analysisVerdictSchema.catch("engine_artifact").parse(category);
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}...`;
}
