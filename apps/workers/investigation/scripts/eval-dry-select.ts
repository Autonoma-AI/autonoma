/**
 * Proposal-eval harness (NOT shipped). Runs the REAL investigation selector - clone + diff + code tools +
 * the current SELECTOR_SYSTEM_PROMPT via the classifier model - against a list of twin snapshots, and dumps
 * each run's `suggested` proposals. This is the "proper generation" arm of the proposal eval: unlike the
 * earlier reconstruction (PR title/body only), the selector here has full codebase grounding. It writes
 * NOTHING to prod: no shadow generations, no cost rows - only clones to a temp dir (disposed) and reads.
 *
 * Run with the worker env (has the AI-gateway + GitHub-App creds; the harness never touches the DB except
 * the read-only snapshot/catalog queries the selector already does):
 *   tsx --env-file=<dir>/.worker.env scripts/eval-dry-select.ts <cases.json> <out.json> [concurrency]
 *
 * cases.json: [{ id, app, pr, twin, ... }] - only `twin` (snapshotId) is required. Cases run through a
 * concurrency pool (default 5): the selector loop is almost all LLM round-trip wait, so overlapping cases is
 * nearly free; clones are brief. Bump/drop the pool with the optional third arg.
 */
import { readFile, writeFile } from "node:fs/promises";
import { db } from "@autonoma/db";
import { LocalCodebaseReader, TestCatalog, selectAffectedTests } from "@autonoma/investigation";
import { logger as rootLogger } from "@autonoma/logger";
import { resolvePrMeta } from "../src/codebase/pr-meta";
import { withSnapshotContext } from "../src/codebase/resolve";
import { env } from "../src/env";
import { createModelSession } from "../src/services";

interface Case {
    id: string;
    app: string;
    pr: number;
    twin: string;
}

interface DryResult {
    id: string;
    app: string;
    pr: number;
    twin: string;
    ok: boolean;
    error?: string;
    prNumber?: number;
    affected?: { slug: string; reason: string }[];
    suggested?: { name: string; description: string; instruction: string; reasoning: string }[];
    quarantine?: { slug: string; reason: string }[];
}

/** Run the selector for ONE twin snapshot with full codebase grounding; no DB writes, clone disposed on exit. */
async function drySelect(c: Case): Promise<DryResult> {
    const logger = rootLogger.child({ name: "eval-dry-select", extra: { twin: c.twin, app: c.app, pr: c.pr } });
    logger.info("Dry select start");
    try {
        return await withSnapshotContext(c.twin, `eval-${c.twin}`, async (context) => {
            const prMeta = await resolvePrMeta(context);
            const reader = new LocalCodebaseReader(context.codebase.root, context.baseSha, context.headSha);
            const session = createModelSession();
            const catalog = new TestCatalog(db);

            const selection = await selectAffectedTests(
                {
                    appSlug: context.appSlug,
                    prNumber: prMeta.prNumber,
                    prTitle: prMeta.prTitle,
                    prBody: prMeta.prBody,
                },
                {
                    codebase: reader,
                    catalog,
                    snapshotId: c.twin,
                    testsCreatedBefore: context.createdAt,
                    reasoningModel: session.getModel({ model: "classifier", tag: "eval-dry-select" }),
                    maxSteps: env.INVESTIGATION_SELECT_MAX_STEPS,
                },
            );
            logger.info("Dry select done", {
                extra: { suggested: selection.suggested.length, affected: selection.affected.length },
            });
            return {
                id: c.id,
                app: c.app,
                pr: c.pr,
                twin: c.twin,
                ok: true,
                prNumber: prMeta.prNumber,
                affected: selection.affected,
                suggested: selection.suggested,
                quarantine: selection.quarantine,
            };
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("Dry select failed", { err: error });
        return { id: c.id, app: c.app, pr: c.pr, twin: c.twin, ok: false, error: message };
    }
}

const DEFAULT_CONCURRENCY = 5;

async function main(): Promise<void> {
    const [casesPath, outPath, concurrencyArg] = process.argv.slice(2);
    if (casesPath == null || outPath == null) {
        throw new Error("usage: eval-dry-select.ts <cases.json> <out.json> [concurrency]");
    }
    const concurrency = concurrencyArg != null ? Number(concurrencyArg) : DEFAULT_CONCURRENCY;
    const cases: Case[] = JSON.parse(await readFile(casesPath, "utf8"));
    console.error(`Running dry select on ${cases.length} twin snapshots (concurrency ${concurrency})...`);

    const results: DryResult[] = [];
    let cursor = 0;
    let done = 0;
    // Concurrency pool: N workers pull the next case off a shared cursor. Results are collected as they finish
    // (order-independent - the scorer sorts), with a checkpoint write after each completion.
    const worker = async (): Promise<void> => {
        while (cursor < cases.length) {
            const c = cases[cursor++];
            if (c == null) break;
            const r = await drySelect(c);
            results.push(r);
            done++;
            const n = r.suggested?.length ?? 0;
            console.error(
                `  [${done}/${cases.length}] ${r.ok ? "ok " : "ERR"} ${c.app.padEnd(18)} #${String(c.pr).padEnd(6)} ` +
                    `${r.ok ? `${n} suggested, ${r.affected?.length ?? 0} affected` : r.error}`,
            );
            await writeFile(outPath, JSON.stringify(results, null, 2)); // checkpoint after each completion
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));
    console.error(`\nWrote ${results.length} results to ${outPath}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
