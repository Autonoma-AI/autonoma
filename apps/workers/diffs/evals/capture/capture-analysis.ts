import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger as rootLogger } from "@autonoma/logger";
import { assembleDiffsAgentInput } from "../../src/analysis/assemble-input";
import { createGithubApp } from "../../src/create-services";
import { serializeAnalysisInput } from "../analysis/analysis-input";
import { ensureCachedCheckout } from "../framework/codebase-cache";
import { resolveSnapshotCoords } from "./snapshot-coords";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where Analysis cases live - the same folder the eval suite loads from. */
const CASES_DIR = path.resolve(__dirname, "..", "analysis", "cases");

export interface CaptureAnalysisParams {
    snapshotId: string;
    /** Case folder name (defaults to the snapshot id). */
    name?: string;
    /** Overwrite an existing case folder. */
    force?: boolean;
}

/**
 * Capture an Analysis eval case from a live snapshot.
 *
 * Resolves the snapshot's git coordinates, validates both SHAs are fetchable
 * (refusing to write a case otherwise), runs the shared Analysis side-input
 * loaders against a real codebase clone, freezes the assembled `DiffsAgentInput`
 * to `input.json` (codebase as coords, `FlowIndex` as an array), and scaffolds a
 * blank `expected.md` (`skip: true`) for the author to fill in.
 *
 * The test suite is loaded from the *previous* snapshot (`testSuiteSource:
 * "previous"`): by capture time the pipeline has rewritten this snapshot's own
 * assignments, so only the previous snapshot still holds the baseline analysis
 * actually saw.
 */
export async function captureAnalysis(params: CaptureAnalysisParams): Promise<string> {
    const logger = rootLogger.child({ name: "captureAnalysis" });
    const { snapshotId } = params;
    const name = params.name ?? snapshotId;
    const caseDir = path.join(CASES_DIR, name);

    logger.info("Capturing analysis case", { extra: { snapshotId, name, caseDir } });

    if (existsSync(caseDir) && params.force !== true) {
        throw new Error(`Case folder already exists: ${caseDir} (pass --force to overwrite)`);
    }

    const githubApp = createGithubApp();
    const coords = await resolveSnapshotCoords(snapshotId, githubApp);

    // Rehydrate through the same cache path the eval uses. This both validates
    // SHA-fetchability (throws UnfetchableShaError on a dead SHA, so we never
    // write an unrunnable case) and gives the merge flow a real working tree.
    const codebase = await ensureCachedCheckout(coords, { githubApp });

    // Use the *previous* snapshot's suite as the baseline: by capture time the
    // pipeline has already rewritten this snapshot's own assignments, so reading
    // them would not reflect what analysis actually saw. The previous snapshot
    // holds the unmutated baseline the production run started from.
    const { agentInput } = await assembleDiffsAgentInput({ snapshotId, codebase, testSuiteSource: "previous" });
    const frozenInput = serializeAnalysisInput(coords, agentInput);

    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, "input.json"), `${JSON.stringify(frozenInput, null, 2)}\n`, "utf-8");
    await writeFile(path.join(caseDir, "expected.md"), blankExpected(snapshotId), "utf-8");

    logger.info("Captured analysis case", {
        extra: {
            caseDir,
            existingTests: frozenInput.existingTests.length,
            flows: frozenInput.flowIndex.length,
        },
    });

    return caseDir;
}

function blankExpected(snapshotId: string): string {
    return `---
description: "Captured from snapshot ${snapshotId} - TODO: describe what this case exercises"
skip: true
# Deterministic checks (uncomment + fill in, then set skip: false):
# affected:
#   include: []   # slugs that MUST be reported affected
#   exclude: []   # slugs that must NOT be reported affected
#   exact: []     # the exact affected set (order-insensitive)
# candidates:
#   minCount: 0
#   maxCount: 0
---

TODO: author the LLM-judge rubric here.

The judge sees only the agent's structured output plus this body - never the
codebase or screenshots. Grade qualities the deterministic checks above cannot
express (was the reasoning sound? are the suggested test candidates sensible and
on-topic? was the right rationale given?). Keep every point additive to the
frontmatter, and phrase each as something checkable from the output alone.
`;
}
