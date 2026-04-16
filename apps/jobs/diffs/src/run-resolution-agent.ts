import { MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import type { PrismaClient } from "@autonoma/db";
import {
    ResolutionAgent,
    type ResolutionAgentInput,
    type ResolutionAgentResult,
    createResolutionCallbacks,
} from "@autonoma/diffs";
import type { FlowIndex } from "@autonoma/diffs";
import type { TestDirectory } from "@autonoma/diffs";
import type { GitHubInstallationClient } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import type { TestSuiteUpdater } from "@autonoma/test-updates";

export interface RunResolutionAgentParams {
    input: ResolutionAgentInput;
    db: PrismaClient;
    updater: TestSuiteUpdater;
    applicationId: string;
    repoDir: string;
    testDirectory: TestDirectory;
    flowIndex: FlowIndex;
    githubClient: GitHubInstallationClient;
    repoId: number;
    headSha: string;
}

export async function runResolutionAgent({
    input,
    db,
    updater,
    applicationId,
    repoDir,
    testDirectory,
    flowIndex,
    githubClient,
    repoId,
    headSha,
}: RunResolutionAgentParams): Promise<ResolutionAgentResult> {
    const registry = new ModelRegistry({
        models: { flash: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
    });
    const model = registry.getModel({ model: "flash", tag: "diffs-resolve" });

    const agent = new ResolutionAgent({
        model,
        workingDirectory: repoDir,
        flowIndex,
        testDirectory,
        maxSteps: 50,
    });

    const startTime = Date.now();
    const result = await agent.resolve(input);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const callbacks = createResolutionCallbacks({
        db,
        updater,
        applicationId,
        testDirectory,
        githubClient,
        repoId,
        headSha,
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
