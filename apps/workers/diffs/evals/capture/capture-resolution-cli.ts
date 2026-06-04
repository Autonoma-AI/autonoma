/**
 * Capture CLI for Resolution eval cases.
 *
 * Usage:
 *   tsx evals/capture/capture-resolution-cli.ts <snapshotId> [--name <case-name>] [--force]
 *
 * Reads the live snapshot from the DB, freezes the assembled ResolutionAgentInput
 * to an on-disk case (`input.json` + a blank `expected.md`). Run via the
 * `capture:resolution` package script so env is loaded from the repo `.env`.
 *
 * Required env: DATABASE_URL + the GITHUB_APP_* credentials (see src/env.ts).
 */

import { parseArgs } from "node:util";
import { logger as rootLogger } from "@autonoma/logger";
import { captureResolution } from "./capture-resolution";

async function main(): Promise<void> {
    const logger = rootLogger.child({ name: "capture-cli" });

    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            name: { type: "string" },
            force: { type: "boolean", default: false },
        },
    });

    const [snapshotId] = positionals;

    if (snapshotId == null) {
        throw new Error("Missing <snapshotId>. Usage: capture:resolution <snapshotId> [--name <case-name>] [--force]");
    }

    const captureParams: Parameters<typeof captureResolution>[0] = { snapshotId, force: values.force };
    if (values.name != null) captureParams.name = values.name;

    const caseDir = await captureResolution(captureParams);

    logger.info("Capture complete", { extra: { caseDir } });
    process.stdout.write(
        `Captured resolution case to ${caseDir}\nEdit expected.md and set skip: false to enable it.\n`,
    );
}

try {
    await main();
} catch (err) {
    console.error(err);
    rootLogger.child({ name: "capture-cli" }).error("Capture failed", err);
    process.exitCode = 1;
}
