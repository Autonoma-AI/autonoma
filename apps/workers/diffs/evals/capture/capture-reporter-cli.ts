/**
 * CLI entry for the Reporter capture command.
 *
 * Usage:
 *   tsx evals/capture/capture-reporter-cli.ts <snapshotId> [--name <case-name>] [--force]
 *
 * Run via the `capture:reporter` package script so env is loaded from the repo `.env`. Required env: DATABASE_URL,
 * the GITHUB_APP_* credentials (to resolve coords and validate SHA-fetchability), and S3 access (the frozen input
 * blob and the referenced screenshots both live there). No model key: capture reads the input the Reporter already
 * serialized and calls no model. The snapshot's Reporter must have run AFTER the input serializer shipped - this
 * corpus is forward-only, so an older run has no blob to capture.
 */

import { parseArgs } from "node:util";
import { logger as rootLogger } from "@autonoma/logger";
import { captureReporter } from "./capture-reporter";

async function main(): Promise<void> {
    const logger = rootLogger.child({ name: "capture-reporter-cli" });

    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            name: { type: "string" },
            force: { type: "boolean", default: false },
        },
    });

    const [snapshotId] = positionals;
    if (snapshotId == null) {
        throw new Error("Missing <snapshotId>. Usage: capture:reporter <snapshotId> [--name <case-name>] [--force]");
    }

    const caseDir = await captureReporter({ snapshotId, force: values.force, name: values.name });

    logger.info("Capture complete", { extra: { caseDir } });
    process.stdout.write(`Captured reporter case to ${caseDir}\nEdit expected.md and set skip: false to enable it.\n`);
}

try {
    await main();
} catch (err) {
    console.error(err);
    rootLogger.child({ name: "capture-reporter-cli" }).error("Capture failed", err);
    process.exitCode = 1;
}
