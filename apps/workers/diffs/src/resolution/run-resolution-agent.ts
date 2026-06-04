import type { PrismaClient } from "@autonoma/db";
import {
    type Codebase,
    ResolutionAgent,
    type ResolutionAgentInput,
    type ResolutionAgentResult,
    createResolutionCallbacks,
    openModelSession,
    summarizeSessionCost,
} from "@autonoma/diffs";
import { logger } from "@autonoma/logger";
import type { TestSuiteUpdater } from "@autonoma/test-updates";
import type { ModelMessage } from "ai";
import type { ResolutionAgentInputWithoutCodebase } from "./assemble-input";

export interface RunResolutionAgentParams {
    /** Everything the ResolutionAgent needs except the codebase clone, which the runner builds. */
    input: ResolutionAgentInputWithoutCodebase;
    db: PrismaClient;
    updater: TestSuiteUpdater;
    /** The on-disk clone (at base + head SHAs), acquired by the activity via `withCodebaseForSnapshot`. */
    codebase: Codebase;
}

export interface AcceptedCandidateLink {
    candidateId: string;
    testCaseId: string;
}

export interface RunResolutionAgentResult extends ResolutionAgentResult {
    accepted: AcceptedCandidateLink[];
    conversation: ModelMessage[];
}

/**
 * Constructs a {@link ResolutionAgent} over a metered {@link openModelSession},
 * runs it against the provided codebase clone, and applies the result by
 * dispatching its modify / remove / report-bug / add-test callbacks. After the
 * run it logs an aggregated cost summary drawn from the session's collector (no
 * DB persistence).
 */
export async function runResolutionAgent({
    input,
    db,
    updater,
    codebase,
}: RunResolutionAgentParams): Promise<RunResolutionAgentResult> {
    const session = openModelSession();
    const model = session.getModel({ model: "smart-visual", tag: "diffs-resolution" });

    const agent = new ResolutionAgent({ model });

    const fullInput: ResolutionAgentInput = { ...input, codebase };
    const { result, conversation } = await agent.run(fullInput);

    const callbacks = createResolutionCallbacks({ db, updater });

    const accepted: AcceptedCandidateLink[] = [];

    await Promise.all([
        ...result.modifiedTests.map((t) => callbacks.modifyTest(t.slug, t.newInstruction)),
        ...result.removedTests.map((t) => callbacks.removeTest(t.slug)),
        ...result.reportedBugs.map((b) => callbacks.reportBug(b)),
        ...result.newTests.map(async (t) => {
            const folder = input.flowIndex.getFlow(t.folderName);
            if (folder == null) throw new Error(`Folder "${t.folderName}" not found for new test "${t.name}"`);
            const { testCaseId } = await callbacks.addTest({ ...t, folderId: folder.id });
            if (t.acceptingCandidateId != null) {
                accepted.push({ candidateId: t.acceptingCandidateId, testCaseId });
            }
        }),
    ]);

    logger.info("Resolution agent cost", { extra: summarizeSessionCost(session.costCollector) });

    logger.info("Resolution agent complete", {
        extra: {
            modifiedTests: result.modifiedTests.length,
            removedTests: result.removedTests.length,
            reportedBugs: result.reportedBugs.length,
            newTests: result.newTests.length,
            acceptedCandidates: accepted.length,
            reasoning: result.reasoning.slice(0, 500),
        },
    });

    return { ...result, accepted, conversation };
}
