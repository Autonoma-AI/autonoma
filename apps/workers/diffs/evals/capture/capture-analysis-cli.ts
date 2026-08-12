/**
 * CLI entry for the Analysis capture command.
 *
 * Usage:
 *   tsx evals/capture/capture-analysis-cli.ts <snapshotId> [--name <case-name>] [--force]
 *
 * Run via the `capture:analysis` package script so env is loaded from the repo
 * `.env`. Required env: DATABASE_URL + the GITHUB_APP_* credentials.
 */

import { parseArgs } from "node:util";
import { logger as rootLogger } from "@autonoma/logger";
import { captureAnalysis } from "./capture-analysis";

async function main(): Promise<void> {
    const logger = rootLogger.child({ name: "capture-analysis-cli" });

    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            name: { type: "string" },
            force: { type: "boolean", default: false },
        },
    });

    const [snapshotId] = positionals;
    if (snapshotId == null) {
        throw new Error("Missing <snapshotId>. Usage: capture:analysis <snapshotId> [--name <case-name>] [--force]");
    }

    const params: Parameters<typeof captureAnalysis>[0] = { snapshotId, force: values.force, name: values.name };

    const caseDir = await captureAnalysis(params);

    logger.info("Capture complete", { extra: { caseDir } });
    process.stdout.write(
        `Captured analysis case to ${caseDir}\nA new case needs its expected.md filled in and skip: false.\n`,
    );
}

try {
    await main();
} catch (err) {
    console.error(err);
    rootLogger.child({ name: "capture-analysis-cli" }).error("Capture failed", err);
    process.exitCode = 1;
}
