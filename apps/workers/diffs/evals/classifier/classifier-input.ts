import { ApplicationArchitecture } from "@autonoma/db";
import type { ClassifierInput, RunFacts } from "@autonoma/diffs/analysis";
import { overlayPointSchema } from "@autonoma/types";
import { z } from "zod";
import { type CodebaseCoords, codebaseCoordsSchema } from "../framework";
import { frozenPreviewEnv } from "./frozen-preview-env";

/**
 * Which of the classifier's live-infra capabilities production actually had, recorded at capture.
 *
 * A case frozen from a preview-integrated run may be graded against a classifier that can see less than the one
 * whose verdict is quoted in `capturedCategory`. That gap is a real property of the case, so it is written down
 * rather than left for a reader to infer from an absent field. Whether the replay closes it is a separate
 * question, answered by what the case carries - `previewEnvNames` for env listing, nothing for the other two.
 */
const productionCapabilitiesSchema = z.object({
    /** `get_preview_env` - the preview's configured env-var names. Replayable from `previewEnvNames`. */
    previewEnv: z.boolean(),
    /** `run_script` - a read-only script against the preview's live backend. Never replayable. */
    previewScript: z.boolean(),
    /** `get_app_logs` - the preview's Loki stream over the run window. */
    appLogs: z.boolean(),
});

export type ProductionCapabilities = z.infer<typeof productionCapabilitiesSchema>;

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
 * becomes the prose it would have returned, and the preview's env-var listing becomes the name list it would
 * have filtered. The two capabilities a replay cannot serve at all - the preview's live backend and the
 * app-log stream - are absent by construction and recorded in `productionCapabilities`.
 *
 * `baseSha` / `headSha` are deliberately NOT stored twice: the classifier renders them into its prompt and the
 * clone needs them too, and both read the single pair on `codebase`.
 */
export const classifierCaseInputSchema = z.object({
    codebase: codebaseCoordsSchema,
    appSlug: z.string().min(1),
    prNumber: z.number().int().nonnegative(),
    test: z.object({ slug: z.string().min(1), plan: z.string(), affectedReason: z.string() }),
    provision: z.object({ status: z.string(), detail: z.string(), seeded: z.string().optional() }),
    diffSummary: z.string(),
    prTitle: z.string().optional(),
    prBody: z.string().optional(),
    priorPass: z.object({ category: z.string(), headline: z.string(), rootCause: z.string().optional() }).optional(),
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
    "codebase" | "screenshotLoader" | "previewScript" | "loadBaseline" | "loadAppLogs" | "run"
> & { run: RunFacts };

/** What rehydration yields: the git coordinates, the pure input, and the pieces the caller must fetch. */
export interface RehydratedClassifierInput {
    coords: CodebaseCoords;
    input: FrozenClassifierInput;
    media: FrozenRunMedia;
    baseline: string;
}

/**
 * Reconstruct the classifier input from a parsed case. The codebase, the run media and the baseline come back
 * separately: each needs an async fetch or a closure the caller owns, and returning them as data keeps this
 * function free of every credential the eval defers until it is actually running a case.
 */
export function rehydrateClassifierInput(parsed: ClassifierCaseInput): RehydratedClassifierInput {
    const input: FrozenClassifierInput = {
        appSlug: parsed.appSlug,
        prNumber: parsed.prNumber,
        test: parsed.test,
        provision: parsed.provision,
        diffSummary: parsed.diffSummary,
        prTitle: parsed.prTitle,
        prBody: parsed.prBody,
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

    return { coords: parsed.codebase, input, media: parsed.run, baseline: parsed.baseline };
}

/** What capture holds when it freezes a case: the assembled classifier facts plus their storage addresses. */
export interface ClassifierCaseSource {
    coords: CodebaseCoords;
    appSlug: string;
    prNumber: number;
    test: ClassifierInput["test"];
    provision: ClassifierInput["provision"];
    diffSummary: string;
    prTitle?: string;
    prBody?: string;
    priorPass?: ClassifierInput["priorPass"];
    run: RunFacts;
    recording?: { key: string; isOptimizedMp4: boolean };
    finalScreenshotKey?: string;
    baseline: string;
    /** The preview's full env-var name list, or undefined when it could not be frozen in full. */
    previewEnvNames?: string[];
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
        diffSummary: source.diffSummary,
        prTitle: source.prTitle,
        prBody: source.prBody,
        priorPass: source.priorPass,
        run: { ...source.run, recording: source.recording, finalScreenshotKey: source.finalScreenshotKey },
        baseline: source.baseline,
        previewEnvNames: source.previewEnvNames,
        productionCapabilities: source.productionCapabilities,
    });
}
