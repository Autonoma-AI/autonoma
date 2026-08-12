/**
 * CLI entry for the Classifier capture command.
 *
 * Usage:
 *   tsx evals/capture/capture-classifier-cli.ts <analysisClassificationId> [--name <case-name>] [--force]
 *       [--skip-app-logs]
 *
 * Run via the `capture:classifier` package script so env is loaded from the repo `.env`. Required env:
 * DATABASE_URL, the GITHUB_APP_* credentials, and LOKI_URL for a previewkit-managed PR, whose app-log window is
 * frozen rather than left to a replay that cannot read it. Neither S3 nor a model key: a case addresses its media
 * by storage key and capture calls no model, so both are the evaluation's business. `--skip-app-logs` gives up the
 * log window deliberately, for a run whose logs have aged out of Loki or a machine that cannot reach it.
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
            "skip-app-logs": { type: "boolean", default: false },
        },
    });

    const [classificationId] = positionals;
    if (classificationId == null) {
        throw new Error(
            "Missing <analysisClassificationId>. Usage: capture:classifier <analysisClassificationId> " +
                "[--name <case-name>] [--force] [--skip-app-logs]",
        );
    }

    const caseDir = await captureClassifier({
        classificationId,
        force: values.force,
        name: values.name,
        skipAppLogs: values["skip-app-logs"],
    });

    logger.info("Capture complete", { extra: { caseDir } });
    process.stdout.write(
        `Captured classifier case to ${caseDir}\nA new case needs its expected.md filled in and skip: false.\n`,
    );
}

try {
    await main();
} catch (err) {
    console.error(err);
    rootLogger.child({ name: "capture-classifier-cli" }).error("Capture failed", err);
    process.exitCode = 1;
}
