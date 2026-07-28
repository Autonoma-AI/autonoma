import type { PrismaClient } from "@autonoma/db";

/** One test's outcome to seed onto a run: its test slug and the verdict the run stands behind. */
export interface SeedFinding {
    slug: string;
    category: string;
    headline?: string;
    /** Extra columns on the verdict itself (evidence, media keys, narrative fields). */
    classification?: Record<string, unknown>;
    /** The verdicts this run superseded before reaching the current one - a self-heal leaves one behind. */
    superseded?: { category: string; headline?: string }[];
}

/**
 * Seeds a run's `AnalysisFinding` rows the way the pipeline writes them: the test case / plan / generation chain
 * each verdict FKs, one `AnalysisClassification` per iteration, and the finding pointing at the last of them.
 *
 * Returns a slug -> finding id lookup (the finding's cuid is what the UI routes on), throwing on an unseeded slug
 * so a typo fails on the spot rather than surfacing later as a missing row.
 *
 * The application is derived from the snapshot rather than passed in, because the call sites that attach findings
 * to a snapshot generally do not have it in scope. Test cases are reused across calls for the same application: a
 * slug is unique per application, and a branch's successive snapshots re-investigate the SAME test.
 */
export async function seedAnalysisFindings(
    db: PrismaClient,
    snapshotId: string,
    findings: SeedFinding[],
): Promise<(slug: string) => string> {
    const snapshot = await db.branchSnapshot.findUniqueOrThrow({
        where: { id: snapshotId },
        select: { branch: { select: { applicationId: true, organizationId: true } } },
    });
    const { applicationId, organizationId } = snapshot.branch;

    const findingIdBySlug = new Map<string, string>();
    for (const seed of findings) {
        const testCaseId = await findOrCreateTestCase(db, { applicationId, organizationId, slug: seed.slug });
        const finding = await db.analysisFinding.create({
            data: { reportSnapshotId: snapshotId, testCaseId, organizationId },
        });

        const iterations = [
            ...(seed.superseded ?? []),
            { category: seed.category, headline: seed.headline, extra: seed.classification },
        ];
        let currentClassificationId = "";
        for (const [index, iteration] of iterations.entries()) {
            const generationId = await createGeneration(db, {
                testCaseId,
                organizationId,
                snapshotId,
                slug: seed.slug,
            });
            const classification = await db.analysisClassification.create({
                data: {
                    findingId: finding.id,
                    number: index + 1,
                    generationId,
                    organizationId,
                    category: iteration.category,
                    headline: iteration.headline ?? `${seed.slug} headline`,
                    ...("extra" in iteration ? iteration.extra : undefined),
                },
            });
            currentClassificationId = classification.id;
        }
        await db.analysisFinding.update({ where: { id: finding.id }, data: { currentClassificationId } });
        findingIdBySlug.set(seed.slug, finding.id);
    }

    return (slug) => {
        const findingId = findingIdBySlug.get(slug);
        if (findingId == null) throw new Error(`No finding seeded for slug "${slug}" on snapshot ${snapshotId}`);
        return findingId;
    };
}

/** One iteration's run: each classification pins the generation it judged, so every iteration needs its own. */
async function createGeneration(
    db: PrismaClient,
    {
        testCaseId,
        organizationId,
        snapshotId,
        slug,
    }: { testCaseId: string; organizationId: string; snapshotId: string; slug: string },
): Promise<string> {
    const plan = await db.testPlan.create({
        data: { testCaseId, prompt: `${slug} plan`, organizationId },
    });
    const generation = await db.testGeneration.create({
        data: { testPlanId: plan.id, snapshotId, organizationId, status: "success" },
        select: { id: true },
    });
    return generation.id;
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
        data: { name: slug, slug, applicationId, folderId: folder.id, organizationId },
        select: { id: true },
    });
    return created.id;
}
