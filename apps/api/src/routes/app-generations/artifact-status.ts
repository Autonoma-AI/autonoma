import type { PrismaClient } from "@autonoma/db";
import { type ArtifactStatus, type ArtifactStatusItem, FileDataSchema } from "@autonoma/types";

/**
 * Per-artifact upload progress plus the canonical `complete` flag, shared by the
 * onboarding Setup status endpoint and the onboarding state's `artifactsUploaded`
 * so the step-2 header, the per-item checks, and the bottom banner stay in sync.
 *
 * `complete` is true once the setup is marked `completed`. The CLI marks it on its
 * final step; a manual/admin upload marks it when its upload finishes (see the
 * Finish-setup folder upload). Receiving files alone does not complete a setup -
 * a CLI run can have every artifact uploaded while still running.
 */
export async function computeArtifactStatus(
    db: PrismaClient,
    applicationId: string,
    organizationId?: string,
): Promise<ArtifactStatus> {
    const setup = await db.applicationSetup.findFirst({
        where: { applicationId, organizationId },
        orderBy: { createdAt: "desc" },
        select: {
            status: true,
            events: { where: { type: "file.created" }, select: { data: true } },
        },
    });

    const filePaths = (setup?.events ?? []).flatMap((event) => {
        const parsed = FileDataSchema.safeParse(event.data);
        return parsed.success ? [parsed.data.filePath] : [];
    });

    const testCount = filePaths.filter((path) => path.startsWith("autonoma/qa-tests/")).length;
    const hasKb = filePaths.includes("AUTONOMA.md");
    const hasScenarios = filePaths.includes("scenarios.md");

    const scenarioCount = await db.scenario.count({
        where: { applicationId, organizationId, activeRecipeVersionId: { not: null } },
    });

    const artifacts: ArtifactStatusItem[] = [
        {
            key: "recipe",
            received: scenarioCount > 0,
            meta: scenarioCount > 0 ? `${scenarioCount} scenario${scenarioCount === 1 ? "" : "s"}` : undefined,
        },
        {
            key: "tests",
            received: testCount > 0,
            meta: testCount > 0 ? `${testCount} file${testCount === 1 ? "" : "s"}` : undefined,
        },
        { key: "kb", received: hasKb },
        { key: "scenarios", received: hasScenarios },
    ];

    return { complete: setup?.status === "completed", artifacts };
}
