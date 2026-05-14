import { MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import type { PrismaClient } from "@autonoma/db";
import {
    ResolutionAgent,
    type ResolutionAgentInput,
    type ResolutionAgentResult,
    ScenarioIndex,
    type ScenarioInfo,
    createResolutionCallbacks,
} from "@autonoma/diffs";
import type { FlowIndex } from "@autonoma/diffs";
import { logger } from "@autonoma/logger";
import type { TestSuiteUpdater } from "@autonoma/test-updates";

export interface RunResolutionAgentParams {
    input: ResolutionAgentInput;
    db: PrismaClient;
    updater: TestSuiteUpdater;
    snapshotId: string;
    applicationId: string;
    organizationId: string;
    repoDir: string;
    flowIndex: FlowIndex;
}

export async function runResolutionAgent({
    input,
    db,
    updater,
    snapshotId,
    applicationId,
    organizationId,
    repoDir,
    flowIndex,
}: RunResolutionAgentParams): Promise<ResolutionAgentResult> {
    const registry = new ModelRegistry({
        models: { flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
    });
    const model = registry.getModel({ model: "flash", tag: "diffs-resolve" });

    const scenarioIndex = await loadScenarioIndex(db, applicationId);

    const agent = new ResolutionAgent({
        model,
        workingDirectory: repoDir,
        flowIndex,
        scenarioIndex,
        maxSteps: 50,
    });

    const startTime = Date.now();
    const result = await agent.resolve(input);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const callbacks = createResolutionCallbacks({
        db,
        updater,
        snapshotId,
        applicationId,
        organizationId,
    });

    await Promise.all([
        ...result.modifiedTests.map((t) => callbacks.modifyTest(t.slug, t.newInstruction)),
        ...result.quarantinedTests.map((t) => callbacks.quarantineTest(t.slug)),
        ...result.reportedBugs.map((b) => callbacks.reportBug(b)),
        ...result.newTests.map((t) => callbacks.addTest({ ...t, folderId: flowIndex.getFlow(t.folderName)!.id })),
    ]);

    logger.info("Resolution agent complete", {
        elapsed: `${elapsed}s`,
        modifiedTests: result.modifiedTests.length,
        quarantinedTests: result.quarantinedTests.length,
        reportedBugs: result.reportedBugs.length,
        newTests: result.newTests.length,
        reasoning: result.reasoning.slice(0, 500),
        modelUsage: registry.modelUsage,
    });

    return result;
}

async function loadScenarioIndex(db: PrismaClient, applicationId: string): Promise<ScenarioIndex> {
    logger.info("Loading scenarios for resolution agent", { applicationId });

    const scenarios = await db.scenario.findMany({
        where: { applicationId, isDisabled: false },
        select: {
            id: true,
            name: true,
            description: true,
            activeRecipeVersion: {
                select: { fingerprint: true, fixtureJson: true, validationStatus: true },
            },
            instances: {
                where: { status: "UP_SUCCESS" },
                orderBy: { upAt: "desc" },
                take: 3,
                select: { metadata: true },
            },
        },
    });

    const infos: ScenarioInfo[] = scenarios.map((s) => {
        const sample = s.instances.find((i) => i.metadata != null);
        return {
            id: s.id,
            name: s.name,
            description: s.description ?? undefined,
            activeRecipe:
                s.activeRecipeVersion != null
                    ? {
                          fingerprint: s.activeRecipeVersion.fingerprint,
                          fixtureJson: s.activeRecipeVersion.fixtureJson,
                          validationStatus: s.activeRecipeVersion.validationStatus,
                      }
                    : undefined,
            sampleMetadata: sample?.metadata ?? undefined,
        };
    });

    logger.info("Loaded scenarios", { count: infos.length });
    return new ScenarioIndex(infos);
}
