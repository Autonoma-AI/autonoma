import { VideoProcessor } from "@autonoma/ai";
import { env as aiEnv } from "@autonoma/ai/env";
import { db } from "@autonoma/db";
import { GenerationReviewer, openModelSession } from "@autonoma/diffs";
import { logger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { GoogleGenAI } from "@google/genai";
import { withCodebaseForGeneration } from "../../codebase/resolve";
import { GenerationContextLoader } from "./context-loader";

const generationIdArg = process.argv[2];
if (generationIdArg == null) {
    console.error("Usage: review:generation <generationId>");
    process.exit(1);
}
const generationId: string = generationIdArg;

logger.info("Local generation reviewer (read-only - no DB writes)");

const storage = S3Storage.createFromEnv();
const contextLoader = new GenerationContextLoader(db, storage);

const session = openModelSession();
const model = session.getModel({ model: "smart-visual", tag: "analysis" });
const videoProcessor = new VideoProcessor(new GoogleGenAI({ apiKey: aiEnv.GEMINI_API_KEY }));

try {
    await withCodebaseForGeneration(generationId, {
        targetDirSeed: `cli-gen-${generationId}`,
        body: async (codebase) => {
            const context = await contextLoader.load(generationId);
            const reviewer = new GenerationReviewer({
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
    logger.fatal("Local generation reviewer failed", error);
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
    process.stdout.write("GenerationReview (local, read-only)\n");
    process.stdout.write(`${"=".repeat(60)}\n`);
    process.stdout.write(`Verdict:    ${verdict.verdict}\n`);
    process.stdout.write(`Confidence: ${verdict.confidence}\n`);
    process.stdout.write(`Severity:   ${verdict.severity}\n`);
    process.stdout.write(`Title:      ${verdict.title}\n\n`);
    process.stdout.write(`Reasoning:\n${verdict.reasoning}\n`);
    process.stdout.write(`${"=".repeat(60)}\n\n`);
}
