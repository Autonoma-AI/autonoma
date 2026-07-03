import { type PrismaClient, db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { CreateValidationGenerationInput, CreateValidationGenerationOutput } from "@autonoma/workflow/activities";
import { type SnapshotMeta, resolveSnapshotMeta } from "../codebase/resolve";

/**
 * The reserved slug of the ONE shadow test case per application. Every proposed-new-test validation hangs its
 * draft plan off this single hidden case instead of minting a real one per proposal, so the customer catalog
 * never grows a throwaway row. It carries `shadow: true` and is excluded from every user-facing catalog read.
 */
const SHADOW_TEST_CASE_SLUG = "__investigation_shadow__";

/**
 * Prepare a shadow generation for ONE candidate plan in the validate->edit->retry loop (Objective 2c). The
 * workflow then runs it on the web worker and classifies the outcome.
 *
 * A modification attaches a DRAFT plan version to the EXISTING test case without repointing the active
 * assignment - the real suite keeps running its current plan. A NEW test hangs its draft plan off the
 * application's reserved SHADOW test case (created on demand, `shadow: true`), so it can be run and classified
 * without ever adding a throwaway row to the customer's catalog. Either way the generation is `shadow`.
 */
export async function createValidationGeneration(
    input: CreateValidationGenerationInput,
): Promise<CreateValidationGenerationOutput> {
    const { snapshotId, plan, baseSlug } = input;
    const logger = rootLogger.child({ name: "createValidationGeneration", extra: { snapshotId, baseSlug } });
    logger.info("Preparing a validation generation");

    const meta = await resolveSnapshotMeta(snapshotId);
    return baseSlug == null
        ? prepareNewTestValidation({ meta, snapshotId, plan, logger })
        : prepareModificationValidation({ meta, snapshotId, plan, baseSlug, logger });
}

/**
 * Modification: attach a draft plan to the existing test case (inheriting its assignment's scenario so the run
 * seeds the same data), then a shadow generation. The active assignment is untouched - nothing user-facing moves.
 */
async function prepareModificationValidation(params: {
    meta: SnapshotMeta;
    snapshotId: string;
    plan: string;
    baseSlug: string;
    logger: ReturnType<typeof rootLogger.child>;
}): Promise<CreateValidationGenerationOutput> {
    const { meta, snapshotId, plan, baseSlug, logger } = params;

    const testCase = await db.testCase.findFirst({
        where: { applicationId: meta.applicationId, slug: baseSlug, shadow: false },
        select: { id: true },
    });
    if (testCase == null) {
        return { skippedReason: `no test case '${baseSlug}' to attach a draft plan to` };
    }

    const assignment = await db.testCaseAssignment.findUnique({
        where: { snapshotId_testCaseId: { snapshotId, testCaseId: testCase.id } },
        select: { plan: { select: { scenarioId: true, scenarioName: true } } },
    });

    const draftPlan = await db.testPlan.create({
        data: {
            testCaseId: testCase.id,
            prompt: plan,
            organizationId: meta.organizationId,
            scenarioId: assignment?.plan?.scenarioId ?? undefined,
            scenarioName: assignment?.plan?.scenarioName ?? undefined,
        },
        select: { id: true, scenarioId: true },
    });

    const generation = await createShadowGeneration(db, draftPlan.id, snapshotId, meta.organizationId);
    logger.info("Modification validation generation ready", { extra: { testGenerationId: generation.id } });
    return { testGenerationId: generation.id, scenarioId: draftPlan.scenarioId ?? undefined, slug: baseSlug };
}

/**
 * New test: hang the draft plan off the application's reserved shadow test case, then a shadow generation. No
 * scenario is bound (a brand-new proposal has no assignment yet), so it runs without seeded data - enough to
 * prove the plan is executable. Returns `skippedReason` only when the app has no folder to place the shadow case.
 */
async function prepareNewTestValidation(params: {
    meta: SnapshotMeta;
    snapshotId: string;
    plan: string;
    logger: ReturnType<typeof rootLogger.child>;
}): Promise<CreateValidationGenerationOutput> {
    const { meta, snapshotId, plan, logger } = params;

    const shadowTestCaseId = await resolveShadowTestCaseId(db, meta);
    if (shadowTestCaseId == null) {
        return { skippedReason: "app has no folder to place a shadow test case for new-test validation" };
    }

    const draftPlan = await db.testPlan.create({
        data: { testCaseId: shadowTestCaseId, prompt: plan, organizationId: meta.organizationId },
        select: { id: true },
    });

    const generation = await createShadowGeneration(db, draftPlan.id, snapshotId, meta.organizationId);
    logger.info("New-test validation generation ready", { extra: { testGenerationId: generation.id } });
    // slug is left undefined - the workflow classifies it under a generic "validation-candidate" label.
    return { testGenerationId: generation.id, scenarioId: undefined, slug: undefined };
}

/**
 * Get (creating on first use) the application's single reserved shadow test case. Reuses an existing folder so
 * no shadow FOLDER leaks into the tree either. Returns undefined when the app has no folder at all (an app under
 * investigation always has real tests, hence folders, so this is only a defensive guard).
 */
async function resolveShadowTestCaseId(prisma: PrismaClient, meta: SnapshotMeta): Promise<string | undefined> {
    const folder = await prisma.folder.findFirst({
        where: { applicationId: meta.applicationId },
        select: { id: true },
    });
    if (folder == null) return undefined;

    const shadowCase = await prisma.testCase.upsert({
        where: { applicationId_slug: { applicationId: meta.applicationId, slug: SHADOW_TEST_CASE_SLUG } },
        update: {},
        create: {
            name: "Investigation validation probe",
            slug: SHADOW_TEST_CASE_SLUG,
            description:
                "Throwaway case the investigation agent uses to validate proposed new tests. Not part of the suite.",
            shadow: true,
            applicationId: meta.applicationId,
            organizationId: meta.organizationId,
            folderId: folder.id,
        },
        select: { id: true },
    });
    return shadowCase.id;
}

/** A shadow generation: a validation probe, kept out of the customer's generation UI and the refinement dedup. */
function createShadowGeneration(prisma: PrismaClient, testPlanId: string, snapshotId: string, organizationId: string) {
    return prisma.testGeneration.create({
        data: { testPlanId, snapshotId, organizationId, shadow: true },
        select: { id: true },
    });
}
