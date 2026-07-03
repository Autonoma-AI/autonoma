import { db } from "@autonoma/db";
import {
    CarryForwardSelector,
    LocalCodebaseReader,
    TestCatalog,
    persistInvestigationCosts,
    selectAffectedTests,
} from "@autonoma/investigation";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { WorkflowArchitecture } from "@autonoma/workflow";
import type {
    InvestigationSelectedTest,
    SelectInvestigationTestsInput,
    SelectInvestigationTestsOutput,
} from "@autonoma/workflow/activities";
import { resolvePrMeta } from "../codebase/pr-meta";
import { type SnapshotContext, withSnapshotContext } from "../codebase/resolve";
import { env } from "../env";
import { createModelSession } from "../services";

/** Why a carried-forward test is in the run set - fed to the classifier as context and shown in the report. */
const CARRY_FORWARD_REASON =
    "Regression re-run: this test did not pass on the previous snapshot and is assumed unfixed until a run proves otherwise.";

interface ShadowGeneration {
    testGenerationId: string;
    scenarioId?: string;
    architecture: WorkflowArchitecture;
}

/**
 * Select the tests a PR's diff affects, create a shadow TestGeneration for each runnable one, and return
 * the list for the workflow to run. Cloning + the LLM selection happen here; the browser runs are dispatched
 * by the workflow.
 */
export async function selectInvestigationTests(
    input: SelectInvestigationTestsInput,
): Promise<SelectInvestigationTestsOutput> {
    const { snapshotId } = input;
    const logger = rootLogger.child({ name: "selectInvestigationTests", extra: { snapshotId } });
    logger.info("Selecting investigation tests");

    return withSnapshotContext(snapshotId, `select-${snapshotId}`, async (context) => {
        const prMeta = await resolvePrMeta(context);
        const reader = new LocalCodebaseReader(context.codebase.root, context.baseSha, context.headSha);
        const session = createModelSession();
        const catalog = new TestCatalog(db);

        // The app's architecture is invariant for the snapshot; resolve it once here rather than per shadow
        // generation. v1 runs shadow generations only on the web worker, so a non-web app selects nothing.
        const application = await db.application.findUniqueOrThrow({
            where: { id: context.applicationId },
            select: { architecture: true },
        });
        const isWebApp = application.architecture === "WEB";

        const selection = await selectAffectedTests(
            { appSlug: context.appSlug, prNumber: prMeta.prNumber, prTitle: prMeta.prTitle, prBody: prMeta.prBody },
            {
                codebase: reader,
                catalog,
                // Select from the tests assigned to THIS (investigation) snapshot - the branch's frozen baseline
                // suite. The snapshot is detached and never mutated by the diffs agent, so its assignment set is
                // exactly the pre-PR suite; no time cutoff or org-catalog fallback is needed or wanted.
                // Use the reliable text classifier model (gpt-5.5), not gemini/smart-visual: selection reads
                // the diff + code (no vision needed), and gemini repeatedly returned no structured output.
                snapshotId,
                reasoningModel: session.getModel({ model: "classifier", tag: "investigation-select" }),
                maxSteps: env.INVESTIGATION_SELECT_MAX_STEPS,
            },
        );
        await persistInvestigationCosts(db, snapshotId, session.costCollector, logger);

        const tests: InvestigationSelectedTest[] = [];
        for (const affected of selection.affected) {
            const shadow = await createShadowGeneration(catalog, snapshotId, context, affected.slug, isWebApp);
            if (shadow == null) {
                logger.warn("Skipping affected test - it has no test plan to run (empty/bad test)", {
                    extra: { slug: affected.slug },
                });
                continue;
            }
            tests.push({
                slug: affected.slug,
                reason: affected.reason,
                testGenerationId: shadow.testGenerationId,
                scenarioId: shadow.scenarioId,
                architecture: shadow.architecture,
            });
        }

        // Regression running: also re-run tests that did not pass on the previous twin (carried by their prior
        // RUN RESULTS, never the current catalog, so this cannot re-introduce a post-base test), deduped against
        // the diff-affected set. A carried test that goes green here retires automatically next snapshot.
        const carried = await appendCarryForwardTests(tests, catalog, snapshotId, context, isWebApp, logger);

        logger.info("Prepared shadow generations", {
            extra: {
                selected: selection.affected.length,
                carried,
                prepared: tests.length,
                suggested: selection.suggested.length,
                quarantine: selection.quarantine.length,
            },
        });
        return {
            appSlug: context.appSlug,
            prNumber: prMeta.prNumber,
            tests,
            suggested: selection.suggested,
            quarantine: selection.quarantine,
            autofixEnabled: await isAutofixEnabled(context.organizationId),
        };
    });
}

/**
 * Append the branch's carry-forward tests to the run set: existing tests that did not pass on the previous
 * twin, re-run so a regression keeps being verified until it passes (then it retires - it simply stops being
 * in the non-passing set). Deduped against the diff-affected set so no test runs twice, and re-materialized
 * against THIS snapshot's pinned baseline via `createShadowGeneration`, so a carried test that is no longer in
 * the baseline is skipped. Contained: a carry-forward failure never sinks selection (the diff-affected set is
 * the deliverable), it just yields no regression re-runs this snapshot. Returns how many tests were added.
 */
async function appendCarryForwardTests(
    tests: InvestigationSelectedTest[],
    catalog: TestCatalog,
    snapshotId: string,
    context: SnapshotContext,
    isWebApp: boolean,
    logger: Logger,
): Promise<number> {
    try {
        // The selector returns already-deduped, net-new slugs (the diff-affected set is excluded), so we can
        // materialize each directly - a slug still resolves to nothing when it is not in the current baseline.
        const carriedSlugs = await new CarryForwardSelector(db).selectCarriedSlugs(
            snapshotId,
            tests.map((test) => test.slug),
        );
        let added = 0;
        for (const slug of carriedSlugs) {
            const shadow = await createShadowGeneration(catalog, snapshotId, context, slug, isWebApp);
            if (shadow == null) {
                logger.info("Skipping carry-forward test - not runnable in the current baseline", {
                    extra: { slug },
                });
                continue;
            }
            tests.push({
                slug,
                reason: CARRY_FORWARD_REASON,
                testGenerationId: shadow.testGenerationId,
                scenarioId: shadow.scenarioId,
                architecture: shadow.architecture,
            });
            added++;
        }
        return added;
    } catch (error) {
        logger.warn("Carry-forward selection failed; running only the diff-affected tests", { err: error });
        return 0;
    }
}

/**
 * Whether the investigation agent may ACT (edit/activate recipes, apply suite edits, post client-factory PR
 * comments) for this org. Org-scoped and off by default: the observe-only shadow runs for everyone via
 * INVESTIGATION_SHADOW_ENABLED, but the mutating steps are gated per trusted org. A missing settings row means
 * the org never opted in, so autofix is off.
 */
async function isAutofixEnabled(organizationId: string): Promise<boolean> {
    const settings = await db.organizationSettings.findUnique({
        where: { organizationId },
        select: { investigationAutofixEnabled: true },
    });
    return settings?.investigationAutofixEnabled ?? false;
}

/**
 * Create a shadow TestGeneration for an affected test, run from the plan the snapshot PINNED for that test (a
 * test IS its plan - the platform has no replays). Running the pinned baseline plan, not the test case's latest
 * plan, keeps the investigation independent of any same-PR plan edit the diffs agent makes. A test that is not
 * assigned to the snapshot, is quarantined, or has no pinned plan isn't a runnable baseline test and is skipped.
 * The generation is created on the (detached) investigation snapshot, so it never touches the diffs snapshot.
 * `isWebApp` is resolved once by the caller (the architecture is invariant for the snapshot).
 */
async function createShadowGeneration(
    catalog: TestCatalog,
    snapshotId: string,
    context: SnapshotContext,
    slug: string,
    isWebApp: boolean,
): Promise<ShadowGeneration | undefined> {
    const pinned = await catalog.resolveSnapshotPlan(snapshotId, slug);
    if (pinned == null) return undefined;

    // v1 runs shadow generations only on the web worker; skip non-web apps until mobile is wired.
    if (!isWebApp) return undefined;

    const generation = await db.testGeneration.create({
        // shadow: this row is created by the investigation agent, not a real user/diffs generation. It must
        // stay invisible to the customer's generation UI and to the refinement loop's dedup - the workflow can
        // stop mid-run and orphan un-run shadow rows in `pending`, and without this marker they are
        // indistinguishable from real pending generations.
        data: { testPlanId: pinned.planId, snapshotId, organizationId: context.organizationId, shadow: true },
        select: { id: true },
    });

    const architecture: WorkflowArchitecture = "WEB";
    return {
        testGenerationId: generation.id,
        scenarioId: pinned.scenarioId,
        architecture,
    };
}
