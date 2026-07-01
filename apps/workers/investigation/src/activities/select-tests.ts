import { db } from "@autonoma/db";
import { LocalCodebaseReader, TestCatalog, selectAffectedTests } from "@autonoma/investigation";
import { logger as rootLogger } from "@autonoma/logger";
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

        const tests: InvestigationSelectedTest[] = [];
        for (const affected of selection.affected) {
            const shadow = await createShadowGeneration(catalog, snapshotId, context, affected.slug);
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

        logger.info("Prepared shadow generations", {
            extra: {
                selected: selection.affected.length,
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
        };
    });
}

/**
 * Create a shadow TestGeneration for an affected test, run from the plan the snapshot PINNED for that test (a
 * test IS its plan - the platform has no replays). Running the pinned baseline plan, not the test case's latest
 * plan, keeps the investigation independent of any same-PR plan edit the diffs agent makes. A test that is not
 * assigned to the snapshot, is quarantined, or has no pinned plan isn't a runnable baseline test and is skipped.
 * The generation is created on the (detached) investigation snapshot, so it never touches the diffs snapshot.
 */
async function createShadowGeneration(
    catalog: TestCatalog,
    snapshotId: string,
    context: SnapshotContext,
    slug: string,
): Promise<ShadowGeneration | undefined> {
    const pinned = await catalog.resolveSnapshotPlan(snapshotId, slug);
    if (pinned == null) return undefined;

    const application = await db.application.findUniqueOrThrow({
        where: { id: context.applicationId },
        select: { architecture: true },
    });
    // v1 runs shadow generations only on the web worker; skip non-web apps until mobile is wired.
    if (application.architecture !== "WEB") return undefined;

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
