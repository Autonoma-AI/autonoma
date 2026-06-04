import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger as rootLogger } from "@autonoma/logger";
import { createGithubApp } from "../../src/create-services";
import { assembleResolutionAgentInput } from "../../src/resolution/assemble-input";
import { ensureCachedCheckout } from "../framework/codebase-cache";
import { serializeResolutionInput } from "../resolution/resolution-input";
import { resolveSnapshotCoords } from "./snapshot-coords";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Where Resolution cases live - the same folder the eval suite loads from. */
const CASES_DIR = path.resolve(__dirname, "..", "resolution", "cases");

export interface CaptureResolutionParams {
    snapshotId: string;
    /** Case folder name (defaults to the snapshot id). */
    name?: string;
    /** Overwrite an existing case folder. */
    force?: boolean;
}

/**
 * Capture a Resolution eval case from a live snapshot.
 *
 * Resolves the snapshot's git coordinates, validates both SHAs are fetchable
 * (refusing to write a case otherwise), runs the shared Resolution side-input
 * loaders, freezes the assembled `ResolutionAgentInput` to `input.json`
 * (codebase as coords, `FlowIndex` / `ScenarioIndex` as arrays), and scaffolds
 * a blank `expected.md` (`skip: true`) for the author to fill in.
 *
 * The baseline state is loaded from the *previous* snapshot (`testSuiteSource:
 * "previous"`): by capture time the pipeline has rewritten this snapshot's own
 * assignments via resolution's callbacks (modify / remove / reportBug
 * quarantine), so only the previous snapshot still holds the suite + quarantine
 * gate resolution actually saw.
 */
export async function captureResolution(params: CaptureResolutionParams): Promise<string> {
    const logger = rootLogger.child({ name: "captureResolution" });
    const { snapshotId } = params;
    const name = params.name ?? snapshotId;
    const caseDir = path.join(CASES_DIR, name);

    logger.info("Capturing resolution case", { extra: { snapshotId, name, caseDir } });

    if (existsSync(caseDir) && params.force !== true) {
        throw new Error(`Case folder already exists: ${caseDir} (pass --force to overwrite)`);
    }

    const githubApp = createGithubApp();
    const coords = await resolveSnapshotCoords(snapshotId, githubApp);

    // Rehydrate through the same cache path the eval uses. Resolution itself
    // does not need the codebase to load its side-inputs, but we run the
    // checkout here to validate SHA-fetchability (throws UnfetchableShaError on
    // a dead SHA) so we never write an unrunnable case.
    await ensureCachedCheckout(coords, { githubApp });

    // Use the *previous* snapshot's state as the baseline: by capture time the
    // pipeline has already rewritten this snapshot's own assignments via
    // resolution's callbacks (modify/remove plus reportBug quarantine), so
    // reading them would not reflect what resolution actually saw. The previous
    // snapshot holds the unmutated baseline the production run started from.
    const { agentInput } = await assembleResolutionAgentInput({ snapshotId, testSuiteSource: "previous" });
    const frozenInput = serializeResolutionInput(coords, agentInput);

    await mkdir(caseDir, { recursive: true });
    await writeFile(path.join(caseDir, "input.json"), `${JSON.stringify(frozenInput, null, 2)}\n`, "utf-8");
    await writeFile(path.join(caseDir, "expected.md"), blankExpected(snapshotId), "utf-8");

    logger.info("Captured resolution case", {
        extra: {
            caseDir,
            existingTests: frozenInput.existingTests.length,
            flows: frozenInput.flowIndex.length,
            scenarios: frozenInput.scenarioIndex.length,
            verdicts: frozenInput.verdicts.length,
            testCandidates: frozenInput.testCandidates.length,
        },
    });

    return caseDir;
}

function blankExpected(snapshotId: string): string {
    return `---
description: "Captured from snapshot ${snapshotId} - TODO: describe what this case exercises"
skip: true
# Deterministic checks (uncomment + fill in, then set skip: false):
# modified:
#   include: []   # slugs that MUST be modified
#   exclude: []   # slugs that must NOT be modified
#   exact: []     # the exact modified set (order-insensitive)
# removed:
#   include: []
#   exclude: []
#   exact: []
# newTests:
#   minCount: 0
#   maxCount: 0
# reportedBugs:
#   minCount: 0
#   maxCount: 0
# acceptsCandidate: []  # candidate ids that MUST appear as some newTests[].acceptingCandidateId
---

TODO: author the LLM-judge rubric here.

The judge sees only the agent's structured output plus this body - never the
codebase or screenshots. Grade qualities the deterministic checks above cannot
express (e.g. is each new-test instruction clear and on-topic? is the modify
reasoning sound? does the bug report accurately describe the failure?). Keep
every point additive to the frontmatter, and phrase each as something
checkable from the output alone.
`;
}
