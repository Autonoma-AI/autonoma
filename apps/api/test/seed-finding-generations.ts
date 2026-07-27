import type { PrismaClient } from "@autonoma/db";

/**
 * Seeds the test case / plan / generation chain each `AnalysisFinding` needs, returning a lookup from slug to the
 * generation id to put on that finding. A finding FKs the generation whose run produced its verdict, so a seeded
 * finding needs a real one; the lookup throws on an unseeded slug so a typo fails on the spot instead of surfacing
 * later as a foreign-key violation.
 *
 * The application is derived from the snapshot rather than passed in, because the call sites that attach findings
 * to a snapshot generally do not have it in scope. Test cases are reused across calls for the same application: a
 * slug is unique per application, and a branch's successive snapshots re-investigate the SAME test, each on its
 * own generation.
 */
export async function seedFindingGenerations(
    db: PrismaClient,
    snapshotId: string,
    slugs: string[],
): Promise<(slug: string) => string> {
    const snapshot = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { branch: { select: { applicationId: true, organizationId: true } } },
    });
    const { applicationId, organizationId } = snapshot.branch;

    const generationIdBySlug = new Map<string, string>();
    for (const slug of slugs) {
        const testCaseId = await findOrCreateTestCase(db, { applicationId, organizationId, slug });
        const plan = await db.testPlan.create({
            data: { testCaseId, prompt: `${slug} plan`, organizationId },
        });
        const generation = await db.testGeneration.create({
            data: { testPlanId: plan.id, snapshotId, organizationId, status: "success" },
            select: { id: true },
        });
        generationIdBySlug.set(slug, generation.id);
    }

    return (slug) => {
        const generationId = generationIdBySlug.get(slug);
        if (generationId == null) throw new Error(`No generation seeded for slug "${slug}" on snapshot ${snapshotId}`);
        return generationId;
    };
}

async function findOrCreateTestCase(
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
        data: { name: `${slug}.md`, slug, applicationId, folderId: folder.id, organizationId },
        select: { id: true },
    });
    return created.id;
}
