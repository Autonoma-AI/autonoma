/**
 * CLI entry for the Classifier capture command.
 *
 * Usage:
 *   tsx evals/capture/capture-classifier-cli.ts <analysisClassificationId> [--name <case-name>] [--force]
 *
 * Run via the `capture:classifier` package script so env is loaded from the repo `.env`. Required env:
 * DATABASE_URL, the GITHUB_APP_* credentials, S3 access, and OPENAI_API_KEY (the vision scans are re-read at
 * capture so the frozen case carries the reads a classification would have seen).
 */

import { parseArgs } from "node:util";
import { logger as rootLogger } from "@autonoma/logger";
import { captureClassifier } from "./capture-classifier";

async function main(): Promise<void> {
    const logger = rootLogger.child({ name: "capture-classifier-cli" });

    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            name: { type: "string" },
            force: { type: "boolean", default: false },
        },
    });

    const [classificationId] = positionals;
    if (classificationId == null) {
        throw new Error(
            "Missing <analysisClassificationId>. Usage: capture:classifier <analysisClassificationId> " +
                "[--name <case-name>] [--force]",
        );
    }

    const caseDir = await captureClassifier({ classificationId, force: values.force, name: values.name });

    logger.info("Capture complete", { extra: { caseDir } });
    process.stdout.write(
        `Captured classifier case to ${caseDir}\nEdit expected.md and set skip: false to enable it.\n`,
    );
}

try {
    await main();
} catch (err) {
    console.error(err);
    rootLogger.child({ name: "capture-classifier-cli" }).error("Capture failed", err);
    process.exitCode = 1;
}
