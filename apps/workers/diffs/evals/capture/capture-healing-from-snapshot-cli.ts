/**
 * CLI entry for the snapshot-based Healing capture (the folded-resolution first
 * turn for pre-#986 / loop-less diffs snapshots).
 *
 * Usage: tsx evals/capture/capture-healing-from-snapshot-cli.ts <snapshotId> [--name <case-name>] [--force]
 *
 * Run via the `capture:healing-from-snapshot` package script so env is loaded
 * from the repo `.env`. Required env: DATABASE_URL + the GITHUB_APP_* credentials.
 */

import { parseArgs } from "node:util";
import { logger as rootLogger } from "@autonoma/logger";
import { captureHealingFromSnapshot } from "./capture-healing-from-snapshot";

async function main(): Promise<void> {
    const logger = rootLogger.child({ name: "capture-healing-from-snapshot-cli" });

    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            name: { type: "string" },
            force: { type: "boolean", default: false },
        },
    });

    const [snapshotId] = positionals;
    if (snapshotId == null) {
        throw new Error(
            "Missing <snapshotId>. Usage: capture:healing-from-snapshot <snapshotId> [--name <case-name>] [--force]",
        );
    }

    const params: Parameters<typeof captureHealingFromSnapshot>[0] = {
        snapshotId,
        force: values.force,
        name: values.name,
    };

    const caseDir = await captureHealingFromSnapshot(params);

    logger.info("Capture complete", { extra: { caseDir } });
    process.stdout.write(
        `Captured first-turn healing case to ${caseDir}\nEdit expected.md and set skip: false to enable it.\n`,
    );
}

try {
    await main();
} catch (err) {
    console.error(err);
    rootLogger.child({ name: "capture-healing-from-snapshot-cli" }).error("Capture failed", err);
    process.exitCode = 1;
}
