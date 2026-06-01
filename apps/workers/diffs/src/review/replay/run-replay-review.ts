import { VideoProcessor } from "@autonoma/ai";
import { env as aiEnv } from "@autonoma/ai/env";
import { db } from "@autonoma/db";
import { ReplayReviewer, openModelSession } from "@autonoma/diffs";
import { logger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { GoogleGenAI } from "@google/genai";
import { withCodebaseForRun } from "../../codebase/resolve";
import { RunContextLoader } from "./context-loader";

const runIdArg = process.argv[2];
if (runIdArg == null) {
    console.error("Usage: review:replay <runId>");
    process.exit(1);
}
const runId: string = runIdArg;

logger.info("Local replay reviewer (read-only - no DB writes)");

const run = await db.run.findUniqueOrThrow({
    where: { id: runId },
    select: { status: true },
});

if (run.status !== "failed") {
    logger.info("Run is not failed - replay reviewer is failure-only", { runId, status: run.status });
    process.exit(0);
}

const storage = S3Storage.createFromEnv();
const contextLoader = new RunContextLoader(db, storage);

const session = openModelSession();
const model = session.getModel({ model: "smart-visual", tag: "analysis" });
const videoProcessor = new VideoProcessor(new GoogleGenAI({ apiKey: aiEnv.GEMINI_API_KEY }));

try {
    await withCodebaseForRun(runId, {
        targetDirSeed: `cli-run-${runId}`,
        body: async (codebase) => {
            const context = await contextLoader.load(runId);
            const reviewer = new ReplayReviewer({
                model,
                evidenceLoader: contextLoader,
                videoProcessor,
            });
            try {
                const { result: verdict } = await reviewer.run({ context, codebase });
                printVerdict(verdict);
            } catch (err) {
                logger.warn("No verdict produced - the agent reached its step limit without submitting one", {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        },
    });
    process.exit(0);
} catch (error) {
    logger.fatal("Local replay reviewer failed", error);
    process.exit(1);
}

function printVerdict(verdict: {
    verdict: string;
    reasoning: string;
    title: string;
    confidence: number;
    severity: string;
}) {
    process.stdout.write(`\n${"=".repeat(60)}\n`);
    process.stdout.write("RunReview (local, read-only)\n");
    process.stdout.write(`${"=".repeat(60)}\n`);
    process.stdout.write(`Verdict:    ${verdict.verdict}\n`);
    process.stdout.write(`Confidence: ${verdict.confidence}\n`);
    process.stdout.write(`Severity:   ${verdict.severity}\n`);
    process.stdout.write(`Title:      ${verdict.title}\n\n`);
    process.stdout.write(`Reasoning:\n${verdict.reasoning}\n`);
    process.stdout.write(`${"=".repeat(60)}\n\n`);
}
