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

        const selection = await selectAffectedTests(
            { appSlug: context.appSlug, prNumber: prMeta.prNumber, prTitle: prMeta.prTitle, prBody: prMeta.prBody },
            {
                codebase: reader,
                catalog: new TestCatalog(db),
                applicationId: context.applicationId,
                // Select only from the tests assigned to THIS snapshot (the branch's copy of the suite), not
                // the whole org catalog, and drop any created after the snapshot (the deployed agent's same-PR
                // additions). Scoping to the snapshot's assignment set first makes the createdAt filter safe -
                // unlike a bare cutoff over the full catalog, which a suite regeneration can empty out.
                snapshotId,
                testsCreatedBefore: context.createdAt,
                // Use the reliable text classifier model (gpt-5.5), not gemini/smart-visual: selection reads
                // the diff + code (no vision needed), and gemini repeatedly returned no structured output.
                reasoningModel: session.getModel({ model: "classifier", tag: "investigation-select" }),
                maxSteps: env.INVESTIGATION_SELECT_MAX_STEPS,
            },
        );

        const tests: InvestigationSelectedTest[] = [];
        for (const affected of selection.affected) {
            const shadow = await createShadowGeneration(snapshotId, context, affected.slug);
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
 * Create a shadow TestGeneration for an affected test, run from the test's LATEST plan. A test IS its plan
 * (the platform has no replays), so we run any affected test we have a plan for - regardless of whether it
 * is attached to this PR's snapshot - against the PR's preview. A test with no plan at all isn't a runnable
 * test (an empty/bad test) and is skipped.
 */
async function createShadowGeneration(
    snapshotId: string,
    context: SnapshotContext,
    slug: string,
): Promise<ShadowGeneration | undefined> {
    const testCase = await db.testCase.findFirst({
        where: { applicationId: context.applicationId, slug },
        select: {
            id: true,
            plans: { select: { id: true, scenarioId: true }, orderBy: { createdAt: "desc" }, take: 1 },
        },
    });
    if (testCase == null) return undefined;

    const plan = testCase.plans[0];
    if (plan == null) return undefined;

    const application = await db.application.findUniqueOrThrow({
        where: { id: context.applicationId },
        select: { architecture: true },
    });
    // v1 runs shadow generations only on the web worker; skip non-web apps until mobile is wired.
    if (application.architecture !== "WEB") return undefined;

    const generation = await db.testGeneration.create({
        data: { testPlanId: plan.id, snapshotId, organizationId: context.organizationId },
        select: { id: true },
    });

    const architecture: WorkflowArchitecture = "WEB";
    return {
        testGenerationId: generation.id,
        scenarioId: plan.scenarioId ?? undefined,
        architecture,
    };
}
