import type { Finding, Issue, IssueReconciliation } from "@autonoma/analysis";
import { persistAiCosts } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { StorageEvidenceLoader, resolveScenarioRecipesForSnapshot, summarizeScenarioRecipes } from "@autonoma/diffs";
import {
    ReporterAgent,
    type ReporterEvidenceAsset,
    type ReporterExistingIssue,
    type ReporterFinding,
    type ReporterInput,
    type ReporterResult,
    type ReporterScenarioLoader,
    type ReporterScenarioSummary,
    reporterInputStorageKey,
    serializeReporterInput,
} from "@autonoma/diffs/analysis";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { TestSuiteStore } from "@autonoma/test-suite";
import { analysisFindingSortKey, analysisVerdictSchema } from "@autonoma/types";
import type { RunReporterInput, RunReporterOutput } from "@autonoma/workflow/activities";
import { resolveRunTarget } from "../../codebase/run-target";
import { type SnapshotContext, withSnapshotContext } from "../../codebase/snapshot-context";
import { createModelSession, getAnalysisStore, getStorage } from "../../services";
import { uploadConversation } from "../../upload-conversation";
import { loadBranchTests } from "./branch-tests";

/** How many prior branch reports to carry as cumulative context. */
const PRIOR_REPORTS_LIMIT = 3;
/** How much of an existing issue's narrative to show as its cross-time matching summary. */
const NARRATIVE_SUMMARY_CHARS = 240;
/** Cap on how many run-trace step frames a finding offers as fetchable evidence (the key frame is always offered). */
const MAX_TRACE_SCREENSHOTS = 20;

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
 * `issueId`, derives the run's verdict + counts, and creates the AnalysisReport - all through the analysis store's
 * one settlement transaction. The report is born there and nowhere else, so its existence means the Reporter ran; a
 * failure here fails the run, while a run superseded mid-Reporter reports the discard instead.
 */
export async function runReporter(input: RunReporterInput, deps: RunReporterDeps = {}): Promise<RunReporterOutput> {
    const { snapshotId } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "runReporter" });
    logger.info("Reporter stage started");

    const produce = deps.produceResult ?? produceReporterResult;
    const result = await produce(input);

    const settled = await getAnalysisStore()
        .forAnalysis(snapshotId)
        .settleReport({
            content: {
                title: result.title,
                headline: result.headline,
                flows: result.flows,
                reportMarkdown: result.reportMarkdown,
                evidenceManifest: result.reportEvidenceManifest,
            },
            issues: result.issues.map(toReconciliation),
        });

    const output: RunReporterOutput = settled.settled
        ? {
              persisted: true,
              verdict: settled.verdict,
              clientBugCount: settled.clientBugCount,
              issuesOpened: settled.issuesOpened,
              issuesCarried: settled.issuesCarried,
              issuesResolved: settled.issuesResolved,
          }
        : { persisted: false, reason: settled.reason };
    logFlowQuality(result, logger);
    logger.info("Reporter stage finished", { extra: output });
    return output;
}

function toReconciliation(issue: ReporterResult["issues"][number]): IssueReconciliation {
    if (issue.kind === "resolve") {
        return {
            kind: "resolve",
            existingIssueId: issue.existingIssueId,
            resolvingTestSlug: issue.resolvingFindingSlug,
            note: issue.note,
        };
    }
    const content = {
        title: issue.content.title,
        kind: issue.content.kind,
        severity: issue.content.severity,
        expectedBehavior: issue.content.expectedBehavior,
        actualBehavior: issue.content.actualBehavior,
        narrativeMarkdown: issue.content.narrativeMarkdown,
        evidenceManifest: issue.content.evidenceManifest,
        suspectedCause: issue.content.suspectedCause,
        primaryScreenshot: issue.content.primaryScreenshot,
        coveredTestSlugs: issue.content.findingSlugs,
        primaryTestSlug: issue.content.primaryFindingSlug,
    };
    if (issue.kind === "open") return { kind: "open", content };
    return { kind: "carry_forward", existingIssueId: issue.existingIssueId, content };
}

/**
 * The only measurement of how well the agent is clustering. Nothing rejects a bad partition (an unplaced test keeps
 * its verdict and lands under a generic name), so without this we would never learn that the prompt stopped working.
 * A rising sweep share, or a flow count that tracks the test count one-for-one, both mean it has.
 */
function logFlowQuality(result: ReporterResult, logger: Logger): void {
    const placed = result.flows.reduce((total, flow) => total + flow.testSlugs.length, 0);
    logger.info("Reporter flow quality", {
        extra: {
            flowCount: result.flows.length,
            placedTestCount: placed,
            sweptTestCount: result.flowCorrections.sweptSlugs.length,
            duplicateSlugCount: result.flowCorrections.duplicateSlugs.length,
            unknownSlugCount: result.flowCorrections.unknownSlugs.length,
            authoredTitle: result.title !== "",
        },
    });
}

/** The default producer: clone the snapshot's repo and run the real ReporterAgent inside it. */
async function produceReporterResult(input: RunReporterInput): Promise<ReporterResult> {
    const { snapshotId } = input;
    return withSnapshotContext(snapshotId, `reporter-${snapshotId}`, async (context) => {
        const logger = rootLogger.child({ name: "produceReporterResult" });
        const reporterInput = await buildReporterInput(input, context);

        const session = createModelSession();
        const agent = new ReporterAgent({ model: session.getModel({ model: "reporter", tag: "analysis-reporter" }) });
        const { result, conversation } = await agent.run(reporterInput);

        // All three auxiliary writes are best-effort - a failure of any must not discard the report we just
        // produced. The input snapshot is the artifact the Reporter eval reads back as a case (see
        // `uploadReporterInput`).
        await Promise.all([
            uploadConversation({
                storage: getStorage(),
                snapshotId,
                phase: "reporter",
                conversation,
                logger: logger.child({ name: "uploadConversation" }),
            }).catch((error) => logger.warn("Failed to upload reporter conversation", { err: error })),
            persistAiCosts(
                db,
                session.costCollector.getRecords(),
                { investigationSnapshotId: snapshotId },
                logger,
            ).catch((error) => logger.warn("Failed to persist reporter costs", { err: error })),
            uploadReporterInput(snapshotId, reporterInput, logger.child({ name: "uploadReporterInput" })).catch(
                (error) => logger.warn("Failed to upload reporter input snapshot", { err: error }),
            ),
        ]);
        return result;
    });
}

/**
 * Freeze the Reporter's assembled input and upload it so the Reporter eval can read it back as a capturable case.
 * Best-effort by contract (like the conversation upload): the eval corpus must never gate a production run. The
 * key shares the snapshot's `diffs-job/<snapshotId>/` artifact prefix with the conversation upload.
 */
async function uploadReporterInput(snapshotId: string, input: ReporterInput, logger: Logger): Promise<void> {
    const payload = await serializeReporterInput(input);
    const key = reporterInputStorageKey(snapshotId);
    logger.info("Uploading reporter input snapshot", { extra: { key, findings: payload.findings.length } });
    await getStorage().upload(key, Buffer.from(JSON.stringify(payload)));
    logger.info("Uploaded reporter input snapshot", { extra: { key } });
}

/** Assemble the Reporter's input from the run's persisted findings + the branch's issue/report history + deps. */
async function buildReporterInput(input: RunReporterInput, context: SnapshotContext): Promise<ReporterInput> {
    const { snapshotId, impactReasoning } = input;
    const logger = rootLogger.child({ name: "buildReporterInput" });
    const store = getAnalysisStore();
    const ledger = store.forBranch(context.branchId);
    const [target, findings, branchTests, existingIssues, priorReports, scenario] = await Promise.all([
        resolveRunTarget(context),
        store.forAnalysis(snapshotId).findings(),
        loadBranchTests(context.branchId, snapshotId, logger),
        ledger.issues(),
        ledger.priorReports({ excludeSnapshotId: snapshotId, limit: PRIOR_REPORTS_LIMIT }),
        loadScenarioContext(snapshotId),
    ]);

    return {
        appSlug: context.appSlug,
        target,
        range: { baseSha: context.baseSha, headSha: context.headSha },
        impactReasoning,
        findings: toReporterFindings(findings),
        branchTests,
        existingIssues: existingIssues.map(toReporterExistingIssue),
        priorReports,
        scenarioIndex: scenario.index,
        codebase: context.codebase,
        screenshotLoader: new StorageEvidenceLoader(getStorage()),
        scenarioLoader: scenario.loader,
    };
}

/**
 * Shape the store's findings into what the Reporter reasons over (incl. fetchable frames). Only the CURRENT
 * classification is offered: a superseded self-heal iteration is an audit record, and reporting on a verdict this
 * run has already replaced would have the agent narrate a conclusion we no longer hold. A contained investigation
 * - a `failure` and no verdict - is offered as an engine artifact so the coverage gap it leaves is reported, never
 * silently dropped.
 *
 * Sorted by the shared category order, stable over the store's slug order, so the agent's prompt does not depend
 * on the order Postgres happened to return the rows in.
 */
function toReporterFindings(findings: Finding[]): ReporterFinding[] {
    const shaped: ReporterFinding[] = [];
    for (const finding of findings) {
        const current = finding.current;
        if (current == null) {
            if (finding.failure == null) continue;
            shaped.push({
                slug: finding.testCase.slug,
                category: "engine_artifact",
                headline: `The Investigator crashed or timed out: ${finding.failure.message}`,
                selfHealed: false,
                screenshots: [],
            });
            continue;
        }
        shaped.push({
            slug: finding.testCase.slug,
            category: analysisVerdict(current.category),
            headline: current.headline,
            expectedBehavior: current.expectedBehavior,
            actualBehavior: current.actualBehavior,
            whatHappened: current.whatHappened,
            selfHealed: finding.selfHealed,
            plan: current.plan,
            observedAppIssues: current.observedAppIssues,
            falsePositiveRisk: current.falsePositiveRisk,
            codeEvidence: current.evidence,
            screenshots: buildScreenshots(finding.testCase.slug, current.screenshotKey, current.runTrace),
        });
    }
    // Stable sort, so findings stay slug-ordered within their bucket.
    return shaped.sort((left, right) => analysisFindingSortKey(left.category) - analysisFindingSortKey(right.category));
}

/** The fetchable screenshots for one finding: its classifier key frame plus a bounded slice of trace frames. */
function buildScreenshots(
    slug: string,
    screenshotKey: string | undefined,
    runTrace: PrismaJson.InvestigationRunTrace | undefined,
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

function toReporterExistingIssue(issue: Issue): ReporterExistingIssue {
    return {
        id: issue.id,
        title: issue.title,
        kind: issue.kind,
        severity: issue.severity,
        status: issue.status,
        expectedBehavior: issue.expectedBehavior,
        actualBehavior: issue.actualBehavior,
        narrativeSummary: truncate(issue.narrativeMarkdown, NARRATIVE_SUMMARY_CHARS),
        findingSlugs: [...new Set(issue.coveredFindings.map((finding) => finding.slug))],
    };
}

interface ScenarioContext {
    index: ReporterScenarioSummary[];
    loader?: ReporterScenarioLoader;
}

/**
 * Build the light scenario index + on-demand recipe loader for the run's suite. Best-effort: a scenario-load
 * failure degrades to an empty index (the Reporter's read_scenario tool is simply not offered), never sinks it.
 */
async function loadScenarioContext(snapshotId: string): Promise<ScenarioContext> {
    const logger = rootLogger.child({ name: "loadScenarioContext" });
    try {
        const suiteInfo = await new TestSuiteStore(db).read(snapshotId);
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
function collectScenarioIds(suiteInfo: Awaited<ReturnType<TestSuiteStore["read"]>>): string[] {
    const ids = new Set<string>();
    for (const testCase of suiteInfo.testCases) {
        const scenarioId = testCase.plan?.scenarioId;
        if (scenarioId != null) ids.add(scenarioId);
    }
    return [...ids];
}

/** The stored `category` is a plain string; keep the finding's terminal verdict as-is for the Reporter to reason. */
function analysisVerdict(category: string): ReporterFinding["category"] {
    return analysisVerdictSchema.catch("engine_artifact").parse(category);
}

function truncate(text: string, max: number): string {
    return text.length <= max ? text : `${text.slice(0, max)}...`;
}
