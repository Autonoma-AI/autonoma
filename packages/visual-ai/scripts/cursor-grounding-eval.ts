/**
 * Measures whether compositing a mouse cursor into a screenshot degrades point detection.
 *
 * Runs the freestyle-click corpus (the same cases, detector and model the engine uses in
 * production) under several "arms", each drawing the cursor somewhere different, and reports the
 * pass rate per arm. `baseline` runs twice so the spread between the two runs gives the
 * model's own run-to-run noise - the floor any real degradation has to clear.
 *
 * Usage:
 *   pnpm --filter @autonoma/visual-ai cursor-grounding-eval
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import { type BoundingBox, type Point, Screenshot, boundingBoxCenter, boundingBoxContainsPoint } from "@autonoma/image";
import { logger } from "@autonoma/logger";
import { z } from "zod";
import { ScreenshotTestCaseLoader } from "../evals/test-case-loader";
import { GeminiObjectDetector, ObjectPointDetector } from "../src/index";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const CASES_DIR = path.join(__dirname, "../evals/freestyle-click/cases");
const RESULTS_DIR = path.join(__dirname, "../cursor-grounding-results");

/** Concurrent detector calls. Kept modest so the Gemini rate limit, not the pool, is the ceiling. */
const CONCURRENCY = 6;

/** Transient (network / 5xx) failures get this many extra attempts; detector errors do not retry. */
const MAX_RETRIES = 2;

/**
 * Cursor glyph size in image pixels. A real Chrome pointer is ~12x19 at 1x DPR; this is
 * deliberately a touch larger, so the arm is mildly conservative rather than flattering.
 */
const CURSOR_HEIGHT = 26;
const CURSOR_WIDTH = 16;

/** For the `far` arm: how far the cursor is kept from the target, so it is unambiguously elsewhere. */
const FAR_MIN_DISTANCE = 250;

/**
 * A standard arrow pointer: white fill, black outline, soft shadow - what the DOM overlay would
 * draw, and what a screenshot of a real browser session contains.
 */
function cursorSvg(): Buffer {
    return Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${CURSOR_WIDTH}" height="${CURSOR_HEIGHT}" viewBox="0 0 12 19">
            <defs>
                <filter id="s" x="-50%" y="-50%" width="200%" height="200%">
                    <feDropShadow dx="0.5" dy="0.5" stdDeviation="0.5" flood-opacity="0.4" />
                </filter>
            </defs>
            <path d="M0 0 L0 16.5 L4.2 12.4 L6.6 18 L9 17 L6.6 11.4 L11.4 11.4 Z"
                  fill="#ffffff" stroke="#000000" stroke-width="1" stroke-linejoin="round" filter="url(#s)" />
        </svg>`,
    );
}

interface Arm {
    name: string;
    /** Where the cursor tip goes, or undefined to leave the screenshot untouched. */
    tip(target: BoundingBox, resolution: { width: number; height: number }, seed: number): Point | undefined;
}

/**
 * Deterministic pseudo-random in [0, 1) from an integer seed, so an arm draws the cursor in the
 * same place on every run and arms stay comparable across invocations.
 */
function seeded(seed: number): number {
    const x = Math.sin(seed * 12.9898) * 43758.5453;
    return x - Math.floor(x);
}

const ARMS: Arm[] = [
    { name: "baseline", tip: () => undefined },
    { name: "baseline-repeat", tip: () => undefined },
    {
        // The common case: the cursor rests wherever the previous action left it, far from the
        // element the agent is now looking for.
        name: "far",
        tip: (target, resolution, seed) => {
            const center = boundingBoxCenter(target);
            for (let attempt = 0; attempt < 20; attempt++) {
                const x = seeded(seed + attempt * 7) * (resolution.width - CURSOR_WIDTH);
                const y = seeded(seed + attempt * 13 + 1) * (resolution.height - CURSOR_HEIGHT);
                if (Math.hypot(x - center.x, y - center.y) >= FAR_MIN_DISTANCE) return { x, y };
            }
            // Degenerate fallback: opposite corner from the target.
            return {
                x: center.x < resolution.width / 2 ? resolution.width - CURSOR_WIDTH : 0,
                y: center.y < resolution.height / 2 ? resolution.height - CURSOR_HEIGHT : 0,
            };
        },
    },
    {
        // The adversarial case: the cursor sits on the very element being detected, partially
        // occluding it. Happens for real whenever two consecutive actions touch the same control.
        name: "on-target",
        tip: (target) => boundingBoxCenter(target),
    },
];

interface EvalCase {
    instruction: string;
    boundingBox: BoundingBox;
    screenshot: Screenshot;
    pageName: string;
}

interface CaseOutcome {
    arm: string;
    pageName: string;
    instruction: string;
    passed: boolean;
    predicted?: Point;
    failure?: string;
}

async function withCursor(screenshot: Screenshot, tip: Point): Promise<Screenshot> {
    const { width, height } = await screenshot.getResolution();
    const left = Math.max(0, Math.min(Math.round(tip.x), width - CURSOR_WIDTH));
    const top = Math.max(0, Math.min(Math.round(tip.y), height - CURSOR_HEIGHT));

    const composited = screenshot.getSharpImage().composite([{ input: cursorSvg(), left, top }]);
    return Screenshot.fromSharp(composited);
}

async function runCase(
    detector: ObjectPointDetector,
    evalCase: EvalCase,
    arm: Arm,
    seed: number,
): Promise<CaseOutcome> {
    const base = { arm: arm.name, pageName: evalCase.pageName, instruction: evalCase.instruction };

    const resolution = await evalCase.screenshot.getResolution();
    const tip = arm.tip(evalCase.boundingBox, resolution, seed);
    const screenshot = tip == null ? evalCase.screenshot : await withCursor(evalCase.screenshot, tip);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            const predicted = await detector.detectPoint(screenshot, evalCase.instruction);
            return { ...base, passed: boundingBoxContainsPoint(evalCase.boundingBox, predicted), predicted };
        } catch (error) {
            const name = error instanceof Error ? error.constructor.name : "UnknownError";

            // A detector that finds nothing, or finds several candidates, is a real miss - that is
            // exactly the degradation this experiment is looking for, so never retry it away.
            const isDetectorVerdict = name === "NoObjectDetectionError" || name === "AmbiguousObjectDetectionError";
            if (isDetectorVerdict) return { ...base, passed: false, failure: name };

            if (attempt === MAX_RETRIES) {
                logger.warn("Case errored out after retries", {
                    extra: { ...base, attempt, error: error instanceof Error ? error.message : String(error) },
                });
                return { ...base, passed: false, failure: name };
            }
        }
    }

    return { ...base, passed: false, failure: "Unreachable" };
}

async function runPool<T>(jobs: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
    const results: T[] = new Array(jobs.length);
    let next = 0;

    async function worker(): Promise<void> {
        while (next < jobs.length) {
            const index = next++;
            const job = jobs[index];
            if (job == null) continue;
            results[index] = await job();
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
    return results;
}

function summarize(outcomes: CaseOutcome[], arm: string) {
    const armOutcomes = outcomes.filter((o) => o.arm === arm);
    const passed = armOutcomes.filter((o) => o.passed).length;
    const noObject = armOutcomes.filter((o) => o.failure === "NoObjectDetectionError").length;
    const ambiguous = armOutcomes.filter((o) => o.failure === "AmbiguousObjectDetectionError").length;

    return {
        arm,
        total: armOutcomes.length,
        passed,
        passRate: armOutcomes.length > 0 ? passed / armOutcomes.length : 0,
        noObject,
        ambiguous,
    };
}

/**
 * Writes one composited sample per arm and makes no model calls, so the glyph's size and placement
 * can be eyeballed before spending a few hundred paid detections on them.
 */
async function dryRun(cases: EvalCase[]): Promise<void> {
    mkdirSync(RESULTS_DIR, { recursive: true });

    const sample = cases[0];
    if (sample == null) throw new Error("No cases to sample");

    const resolution = await sample.screenshot.getResolution();
    logger.info("Dry run sample", {
        extra: { pageName: sample.pageName, instruction: sample.instruction, target: sample.boundingBox, resolution },
    });

    for (const arm of ARMS) {
        const tip = arm.tip(sample.boundingBox, resolution, 0);
        if (tip == null) continue;

        const composited = await withCursor(sample.screenshot, tip);
        const outPath = path.join(RESULTS_DIR, `sample-${arm.name}.png`);
        writeFileSync(outPath, composited.buffer);
        logger.info(`Wrote ${arm.name} sample`, { extra: { tip, outPath } });
    }
}

async function main() {
    const loader = new ScreenshotTestCaseLoader<EvalCase>({
        testCaseSchema: z.object({
            instruction: z.string(),
            boundingBox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
        }),
        jsonFileName: "boxes.json",
    });

    const cases = loader.loadCases(CASES_DIR);
    if (cases.length === 0) throw new Error(`No cases found in ${CASES_DIR}`);

    if (process.argv.includes("--dry-run")) return dryRun(cases);

    const modelRegistry = new ModelRegistry({ models: { "smart-visual": MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW } });
    const detector = new ObjectPointDetector(
        new GeminiObjectDetector(modelRegistry.getModel({ model: "smart-visual", tag: "point-detection" })),
    );

    logger.info("Starting cursor grounding eval", {
        extra: { cases: cases.length, arms: ARMS.map((a) => a.name), totalCalls: cases.length * ARMS.length },
    });

    const jobs = ARMS.flatMap((arm) => cases.map((evalCase, index) => () => runCase(detector, evalCase, arm, index)));
    const outcomes = await runPool(jobs, CONCURRENCY);

    const summaries = ARMS.map((arm) => summarize(outcomes, arm.name));

    mkdirSync(RESULTS_DIR, { recursive: true });
    const resultPath = path.join(
        RESULTS_DIR,
        `cursor-grounding-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    writeFileSync(resultPath, JSON.stringify({ summaries, outcomes }, null, 4));

    const table = summaries
        .map(
            (s) =>
                `\t${s.arm.padEnd(16)} ${String(s.passed).padStart(3)}/${s.total}  ` +
                `${(s.passRate * 100).toFixed(1).padStart(5)}%   ` +
                `no-object: ${s.noObject}, ambiguous: ${s.ambiguous}`,
        )
        .join("\n");

    logger.info(`\n📊 Cursor grounding eval\n${table}\n\n📁 Results saved to: ${resultPath}`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
