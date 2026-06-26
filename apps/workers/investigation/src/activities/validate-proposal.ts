import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { CreateValidationGenerationInput, CreateValidationGenerationOutput } from "@autonoma/workflow/activities";
import { resolveSnapshotMeta } from "../codebase/resolve";

/**
 * Prepare a shadow generation for ONE candidate plan in the validate->edit->retry loop (Objective 2c). The
 * workflow then runs it on the web worker and classifies the outcome.
 *
 * Modifications attach a DRAFT plan version to the existing test case WITHOUT repointing the active
 * assignment - the real suite keeps running its current plan, so nothing user-facing changes; the draft is
 * used only by the shadow generation here. New-test validation is intentionally skipped: it would need a
 * shadow TestCase, which pollutes the product catalog until a proper shadow-row marker exists.
 */
export async function createValidationGeneration(
    input: CreateValidationGenerationInput,
): Promise<CreateValidationGenerationOutput> {
    const { snapshotId, plan, baseSlug } = input;
    const logger = rootLogger.child({ name: "createValidationGeneration", extra: { snapshotId, baseSlug } });
    logger.info("Preparing a validation generation");

    if (baseSlug == null) {
        return { skippedReason: "new-test validation needs the shadow-test marker (not built yet)" };
    }

    const meta = await resolveSnapshotMeta(snapshotId);
    const testCase = await db.testCase.findFirst({
        where: { applicationId: meta.applicationId, slug: baseSlug },
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

    const generation = await db.testGeneration.create({
        data: { testPlanId: draftPlan.id, snapshotId, organizationId: meta.organizationId },
        select: { id: true },
    });

    logger.info("Validation generation ready", { extra: { testGenerationId: generation.id } });
    return { testGenerationId: generation.id, scenarioId: draftPlan.scenarioId ?? undefined, slug: baseSlug };
}
