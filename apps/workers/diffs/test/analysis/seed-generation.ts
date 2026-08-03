import type { PrismaClient } from "@autonoma/db";

let seq = 0;

/**
 * Seeds the test case / plan / generation chain one `AnalysisFinding` needs: the finding FKs the test case, and its
 * classification FKs the generation whose run it judged, so both ids are returned.
 *
 * The test case's slug matches the finding's, mirroring how the pipeline lines the two up, and is reused across
 * calls for the same application - a slug is unique per application, and a branch's successive runs re-investigate
 * the SAME test, each on its own generation.
 */
export async function seedGenerationForSlug(
    db: PrismaClient,
    params: { applicationId: string; organizationId: string; snapshotId: string; slug: string },
): Promise<{ testCaseId: string; generationId: string }> {
    const { organizationId, snapshotId, slug } = params;

    const testCaseId = await findOrCreateTestCase(db, params);
    const plan = await db.testPlan.create({
        data: { testCaseId, prompt: `${slug} plan ${seq++}`, organizationId },
    });
    const generation = await db.testGeneration.create({
        data: { testPlanId: plan.id, snapshotId, organizationId, status: "success" },
        select: { id: true },
    });

    return { testCaseId, generationId: generation.id };
}

/** The test case a slug names in an application, minting it (with a flow to hold it) the first time. */
export async function findOrCreateTestCase(
    db: PrismaClient,
    { applicationId, organizationId, slug }: { applicationId: string; organizationId: string; slug: string },
): Promise<string> {
    const existing = await db.testCase.findUnique({
        where: { applicationId_slug: { applicationId, slug } },
        select: { id: true },
    });
    if (existing != null) return existing.id;

    const folder = await db.folder.create({
        data: { name: `Flow ${slug}`, applicationId, organizationId },
    });
    const created = await db.testCase.create({
        data: { name: slug, slug, applicationId, folderId: folder.id, organizationId },
        select: { id: true },
    });
    return created.id;
}
