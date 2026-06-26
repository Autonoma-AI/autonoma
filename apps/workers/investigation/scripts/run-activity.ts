/**
 * Dev harness: run one investigation activity directly (no Temporal), for local validation against real
 * data. NOT shipped - run ad hoc with the same env the worker uses:
 *
 *   tsx --env-file=/tmp/investigation-local.env scripts/run-activity.ts select   <snapshotId>
 *   tsx --env-file=/tmp/investigation-local.env scripts/run-activity.ts classify <snapshotId> <slug> <reason> <testGenerationId>
 *   tsx --env-file=/tmp/investigation-local.env scripts/run-activity.ts report   <snapshotId>
 *
 * `classify` against an EXISTING generation that already ran (has a video) exercises the whole classifier
 * without needing the web worker.
 */
import { readFile } from "node:fs/promises";
import type { InvestigationTestResult } from "@autonoma/workflow/activities";
import { classifyInvestigationRun } from "../src/activities/classify-run";
import { selectInvestigationTests } from "../src/activities/select-tests";
import { writeInvestigationReport } from "../src/activities/write-report";

function arg(values: string[], index: number, name: string): string {
    const value = values[index];
    if (value == null || value === "") throw new Error(`missing argument: ${name}`);
    return value;
}

async function main(): Promise<void> {
    const [mode, ...rest] = process.argv.slice(2);

    if (mode === "select") {
        const result = await selectInvestigationTests({ snapshotId: arg(rest, 0, "snapshotId") });
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    if (mode === "classify") {
        const result = await classifyInvestigationRun({
            snapshotId: arg(rest, 0, "snapshotId"),
            slug: arg(rest, 1, "slug"),
            reason: arg(rest, 2, "reason"),
            testGenerationId: arg(rest, 3, "testGenerationId"),
        });
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    if (mode === "report") {
        // The results file is either an array of results, or { results, suggested, quarantine } so the
        // report can also render our proposed new tests + quarantine recommendations from a `select` run.
        // JSON.parse is `any` here - fine for a dev harness reading our own files.
        const resultsPath = rest[1];
        const raw = resultsPath != null ? JSON.parse(await readFile(resultsPath, "utf8")) : [];
        const results: InvestigationTestResult[] = Array.isArray(raw) ? raw : (raw.results ?? []);
        const result = await writeInvestigationReport({
            snapshotId: arg(rest, 0, "snapshotId"),
            results,
            suggested: Array.isArray(raw) ? [] : (raw.suggested ?? []),
            quarantine: Array.isArray(raw) ? [] : (raw.quarantine ?? []),
        });
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    throw new Error("usage: run-activity.ts <select|classify|report [resultsJsonFile]> <args...>");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
