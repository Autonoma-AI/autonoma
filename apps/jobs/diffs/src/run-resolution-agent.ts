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
    repoDir: string;
    flowIndex: FlowIndex;
}

export interface AcceptedCandidateLink {
    candidateId: string;
    testCaseId: string;
}

export interface RunResolutionAgentResult extends ResolutionAgentResult {
    accepted: AcceptedCandidateLink[];
}

export async function runResolutionAgent({
    input,
    db,
    updater,
    repoDir,
    flowIndex,
}: RunResolutionAgentParams): Promise<RunResolutionAgentResult> {
    const registry = new ModelRegistry({
        models: { flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
    });
    const model = registry.getModel({ model: "flash", tag: "diffs-resolve" });

    const scenarioIndex = await loadScenarioIndex(db, updater.applicationId);

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

    const callbacks = createResolutionCallbacks({ db, updater });

    const accepted: AcceptedCandidateLink[] = [];

    await Promise.all([
        ...result.modifiedTests.map((t) => callbacks.modifyTest(t.slug, t.newInstruction)),
        ...result.removedTests.map((t) => callbacks.removeTest(t.slug)),
        ...result.reportedBugs.map((b) => callbacks.reportBug(b)),
        ...result.newTests.map(async (t) => {
            const { testCaseId } = await callbacks.addTest({
                ...t,
                folderId: flowIndex.getFlow(t.folderName)!.id,
            });
            if (t.acceptingCandidateId != null) {
                accepted.push({ candidateId: t.acceptingCandidateId, testCaseId });
            }
        }),
    ]);

    logger.info("Resolution agent complete", {
        elapsed: `${elapsed}s`,
        modifiedTests: result.modifiedTests.length,
        removedTests: result.removedTests.length,
        reportedBugs: result.reportedBugs.length,
        newTests: result.newTests.length,
        acceptedCandidates: accepted.length,
        reasoning: result.reasoning.slice(0, 500),
        modelUsage: registry.modelUsage,
    });

    return { ...result, accepted };
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
