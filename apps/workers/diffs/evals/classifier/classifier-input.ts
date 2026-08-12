import { ApplicationArchitecture } from "@autonoma/db";
import type { ClassifierInput, RunFacts } from "@autonoma/diffs/analysis";
import { investigationEvidenceSchema, overlayPointSchema } from "@autonoma/types";
import { z } from "zod";
import { type CodebaseCoords, codebaseCoordsSchema } from "../framework";
import { frozenPreviewEnv } from "./frozen-preview-env";

/**
 * The one fact production's live-infra tools all hung on: whether previewkit deployed this PR.
 *
 * A case frozen from a preview-integrated run may be graded against a classifier that could see more than this
 * replay can - `run_script` has no frozen form, and a case may carry neither the env-var list nor the log window.
 * That gap is a real property of the case, so it is written down rather than left for a reader to infer from an
 * absent field. Whether the replay closes it is a separate, PER-TOOL question, answered by what the case carries
 * - `previewEnvNames` for env listing, `appLogs` for the log stream, nothing for `run_script`. This single
 * boolean only records what production HAD.
 *
 * It is ONE boolean and not one per tool: production gated every live-infra tool on this single fact, so a
 * per-tool record would carry three values that can never disagree. The per-tool differences are all on the
 * replay side, and live on the frozen data present - not here.
 */
const productionCapabilitiesSchema = z.object({ previewkitManaged: z.boolean() });

export type ProductionCapabilities = z.infer<typeof productionCapabilitiesSchema>;

/**
 * The preview app's log window, frozen UNFILTERED so any regex the classifier invents can still be answered.
 *
 * Production interpolated the model's regex into a LogQL line filter and had Loki evaluate it server-side, so
 * the filter is not knowable at capture time; what is knowable is the stream Loki would have filtered. Capture
 * therefore freezes the whole padded window over the same stream selector and replay does the filtering locally.
 *
 * The window this covers is NOT stored: it is the padded run window the loader derives from `run.startEpoch` /
 * `run.endEpoch`, which capture reads off the same run it freezes, so the two cannot disagree.
 *
 * A window with zero lines is a real, common answer - a preview that emitted nothing the loader states as fact -
 * and is distinct from an ABSENT window, which means the stream was never captured. Capture refuses to write a
 * window it could not query, so an empty one here was genuinely queried and genuinely empty.
 */
const frozenAppLogWindowSchema = z.object({
    /** The previewkit namespace, which the loader renders into its own prose. */
    namespace: z.string().min(1),
    /** Every line over the padded window, oldest first, with the nanosecond timestamps the offsets come from. */
    lines: z.array(
        z.object({
            // A decimal nanosecond epoch, parsed with BigInt when the loader stamps the line's run offset -
            // validated here so a hand-edited fixture fails at load instead of mid-classification.
            timestampNs: z.string().regex(/^\d+$/, "a nanosecond epoch, as decimal digits"),
            line: z.string(),
        }),
    ),
    /**
     * The capture query filled its own cap, so lines older than the oldest one here exist but were not frozen.
     * Replay must then warn about hidden older matches however few the filter finds, exactly as a capped
     * production query did.
     */
    windowTruncated: z.boolean(),
});

export type FrozenAppLogWindow = z.infer<typeof frozenAppLogWindowSchema>;

/**
 * One traced step as `view_step_details` discloses it. Already key-addressed in production, so it freezes
 * verbatim - the frames are rehydrated by the evidence loader when the model drills in, never up front.
 */
const inspectableStepSchema = z.object({
    order: z.number().int(),
    screenshotBeforeKey: z.string().optional(),
    screenshotAfterKey: z.string().optional(),
    overlayPoints: z.array(overlayPointSchema).optional(),
    interaction: z.string().optional(),
    status: z.string().optional(),
    params: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.string().optional(),
    errorName: z.string().optional(),
});

/**
 * The run's artifacts with its two byte-carrying fields replaced by storage keys.
 *
 * The recording carries `isOptimizedMp4` alongside its key because the uploader has to be told a mime type and
 * the key alone does not say: production reads the dead-time-stripped mp4 when the optimizer produced one and
 * the original webm otherwise, and handing the wrong type to the transcoder silently drops the recording.
 */
const frozenRunSchema = z.object({
    success: z.boolean(),
    finishReason: z.string(),
    stepCount: z.number().int().nonnegative(),
    steps: z.array(z.string()),
    reasoning: z.string().optional(),
    startEpoch: z.number().int(),
    endEpoch: z.number().int(),
    inspectableSteps: z.array(inspectableStepSchema),
    architecture: z.enum(ApplicationArchitecture).optional(),
    recording: z.object({ key: z.string().min(1), isOptimizedMp4: z.boolean() }).optional(),
    finalScreenshotKey: z.string().min(1).optional(),
});

/**
 * The frozen, on-disk shape of a captured Classifier case (`input.json`).
 *
 * Mirrors {@link ClassifierInput} with every live handle replaced by something addressable: the `Codebase`
 * becomes {@link CodebaseCoords}, the run's recording and final frame become storage keys, `loadBaseline`
 * becomes the prose it would have returned, the preview's env-var listing becomes the name list it would have
 * filtered, and `loadAppLogs` becomes the unfiltered log window it read from. The one capability a replay cannot
 * serve at all - `run_script`, a query against a live backend - is absent by construction and recorded in
 * `productionCapabilities`.
 *
 * `baseSha` / `headSha` are deliberately NOT stored twice: the classifier renders them into its prompt and the
 * clone needs them too, and both read the single pair on `codebase`.
 *
 * The diff stat is likewise not frozen: it is `git diff base..head --stat` over a clone every case already
 * rehydrates, so the evaluation reads it through the same `readPrDiffStat` production calls. A frozen copy
 * would keep grading the old string if that helper ever changed.
 */
export const classifierCaseInputSchema = z.object({
    codebase: codebaseCoordsSchema,
    appSlug: z.string().min(1),
    prNumber: z.number().int().nonnegative(),
    test: z.object({ slug: z.string().min(1), plan: z.string(), affectedReason: z.string() }),
    provision: z.object({ status: z.string(), detail: z.string(), seeded: z.string().optional() }),
    prTitle: z.string().optional(),
    prBody: z.string().optional(),
    /** Mirrors `ClassifierInput["priorPass"]`: a self-heal re-run is judged against the whole first pass. */
    priorPass: z
        .object({
            category: z.string(),
            headline: z.string(),
            rootCause: z.string().optional(),
            plan: z.string(),
            planMismatchNote: z.string().optional(),
            evidence: z.array(investigationEvidenceSchema),
        })
        .optional(),
    run: frozenRunSchema,
    /** The prior-runs prose, frozen as of the classification so no later run can leak into it. */
    baseline: z.string(),
    /**
     * Every env-var name the PR's preview pod ran with, so a replay can still answer `get_preview_env`.
     *
     * An EMPTY array is a real answer - a preview that configures nothing - and is NOT the same as the field
     * being absent, which says the list could not be frozen honestly. Never a partial list.
     */
    previewEnvNames: z.array(z.string().min(1)).optional(),
    /**
     * The app-log window `get_app_logs` is replayed from. Absent for a case whose preview had no log stream, and
     * for one captured before the window could be frozen (an aged-out run, or a capture that deliberately skipped
     * it). Replay then omits the tool, which `describeEvidenceLimits` tells the model about.
     */
    appLogs: frozenAppLogWindowSchema.optional(),
    productionCapabilities: productionCapabilitiesSchema,
});

export type ClassifierCaseInput = z.infer<typeof classifierCaseInputSchema>;

/** The run's media, still addressed by key - the evaluation fetches the bytes and re-uploads the recording. */
export type FrozenRunMedia = ClassifierCaseInput["run"];

/**
 * Everything the classifier takes that is neither a live handle nor a media blob. `previewEnv` stays in:
 * listing env-var names needs nothing live, so rehydration serves it from the frozen list.
 */
export type FrozenClassifierInput = Omit<
    ClassifierInput,
    "codebase" | "diffSummary" | "screenshotLoader" | "previewScript" | "loadBaseline" | "loadAppLogs" | "run"
> & { run: RunFacts };

/** What rehydration yields: the git coordinates, the pure input, and the pieces the caller must fetch. */
export interface RehydratedClassifierInput {
    coords: CodebaseCoords;
    input: FrozenClassifierInput;
    media: FrozenRunMedia;
    baseline: string;
    appLogs?: FrozenAppLogWindow;
}

/**
 * Reconstruct the classifier input from a parsed case. The codebase, the run media and the baseline come back
 * separately: each needs an async fetch or a closure the caller owns, and returning them as data keeps this
 * function free of every credential the eval defers until it is actually running a case.
 */
export function rehydrateClassifierInput(parsed: ClassifierCaseInput): RehydratedClassifierInput {
    const input: FrozenClassifierInput = {
        appSlug: parsed.appSlug,
        // The on-disk case stays PR-shaped - capture refuses a main-branch run, which carries no PR number to
        // freeze - so every replayed case rebuilds a pull-request target.
        target: {
            kind: "pull_request",
            prNumber: parsed.prNumber,
            prTitle: parsed.prTitle,
            prBody: parsed.prBody,
        },
        test: parsed.test,
        provision: parsed.provision,
        priorPass: parsed.priorPass,
        baseSha: parsed.codebase.baseSha,
        headSha: parsed.codebase.headSha,
        previewEnv: parsed.previewEnvNames != null ? frozenPreviewEnv(parsed.previewEnvNames) : undefined,
        run: {
            success: parsed.run.success,
            finishReason: parsed.run.finishReason,
            stepCount: parsed.run.stepCount,
            steps: parsed.run.steps,
            reasoning: parsed.run.reasoning,
            startEpoch: parsed.run.startEpoch,
            endEpoch: parsed.run.endEpoch,
            inspectableSteps: parsed.run.inspectableSteps,
            architecture: parsed.run.architecture,
        },
    };

    return { coords: parsed.codebase, input, media: parsed.run, baseline: parsed.baseline, appLogs: parsed.appLogs };
}

/** What capture holds when it freezes a case: the assembled classifier facts plus their storage addresses. */
export interface ClassifierCaseSource {
    coords: CodebaseCoords;
    appSlug: string;
    prNumber: number;
    test: ClassifierInput["test"];
    provision: ClassifierInput["provision"];
    prTitle?: string;
    prBody?: string;
    priorPass?: ClassifierInput["priorPass"];
    run: RunFacts;
    recording?: { key: string; isOptimizedMp4: boolean };
    finalScreenshotKey?: string;
    baseline: string;
    /** The preview's full env-var name list, or undefined when it could not be frozen in full. */
    previewEnvNames?: string[];
    /** The unfiltered log window, when the preview had a stream capture could still reach. */
    appLogs?: FrozenAppLogWindow;
    productionCapabilities: ProductionCapabilities;
}

/**
 * Freeze an assembled classification into the on-disk case shape, through the schema so capture can never write
 * a malformed `input.json`.
 */
export function serializeClassifierInput(source: ClassifierCaseSource): ClassifierCaseInput {
    return classifierCaseInputSchema.parse({
        codebase: source.coords,
        appSlug: source.appSlug,
        prNumber: source.prNumber,
        test: source.test,
        provision: source.provision,
        prTitle: source.prTitle,
        prBody: source.prBody,
        priorPass: source.priorPass,
        run: { ...source.run, recording: source.recording, finalScreenshotKey: source.finalScreenshotKey },
        baseline: source.baseline,
        previewEnvNames: source.previewEnvNames,
        appLogs: source.appLogs,
        productionCapabilities: source.productionCapabilities,
    });
}
