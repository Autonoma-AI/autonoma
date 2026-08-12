import type { UploadedVideo } from "@autonoma/ai";
import type { ApplicationArchitecture } from "@autonoma/db";
import type { AnalysisRunTarget } from "@autonoma/types";
import type { InspectableStep, ScreenshotLoader } from "../../agents/tools/run-evidence/run-evidence-types";
import type { Codebase } from "../../codebase";

/** Everything one classification reads off the generation row, with none of the run's media. */
export interface RunFacts {
    success: boolean;
    finishReason: string;
    stepCount: number;
    steps: string[];
    reasoning?: string;
    startEpoch: number;
    endEpoch: number;
    /**
     * Every traced step as `view_step_details` discloses it: the frame keys plus the engine's own record of
     * the step. Identified by the step's `order` exactly as the prompt's trace renders it - NOT by array
     * position, which would silently mis-resolve whenever orders are not a contiguous 1..N.
     *
     * Frames are storage KEYS, not bytes: a run has up to 120 steps and a classification drills into two or
     * three, so they are rehydrated through {@link ClassifierInput.screenshotLoader} on demand.
     */
    inspectableSteps: InspectableStep[];
    /**
     * The application's platform. Governs how a step's resolved click point maps onto its frame, so
     * `view_step_details` only draws the marker where the two share a coordinate space.
     */
    architecture?: ApplicationArchitecture;
}

/**
 * Both media blobs are held in MEMORY as bytes - the generation activity already stored them in S3, and every
 * classification reads both immediately (the four probes watch the video; the prompt inlines the final frame),
 * so the classifier never touches the filesystem.
 */
export interface RunArtifacts extends RunFacts {
    /**
     * The run recording, already in the form the vision models take - the worker uploads it through the
     * uploader its registry entry declares, so nothing here knows or cares whether that is a Files-API URI or
     * inline base64.
     */
    recording?: UploadedVideo;
    finalScreenshot?: Uint8Array;
}

/**
 * Lists the env-var NAMES the PR's preview pod runs with.
 *
 * Separate from {@link PreviewScriptAccess} because it is the freezable half: the answer is a name list plus a
 * local filter, so a caller holding a captured list serves it identically without reaching the pod.
 */
export interface PreviewEnvAccess {
    getEnvVarNames(filter?: string): Promise<string[]>;
}

/** Runs a read-only script against the preview's LIVE backend. Not freezable - it needs the running pod. */
export interface PreviewScriptAccess {
    runScript(input: { script: string; packages?: string[] }): Promise<string>;
}

/**
 * Everything one classification needs: the static facts about the run, the handles its tools read
 * through, and the capabilities the worker wires against real infra (Prisma / Loki / k8s / the clone).
 * The three models are NOT here - they are fixed per agent instance, so they live on the constructor.
 */
export interface ClassifierInput {
    appSlug: string;
    /**
     * What this run analyzed - a PR (with the author's stated intent, a hint only: it is often written at the
     * first commit and never updated, so the diff + code comments are the authoritative intent signal, as the
     * prompt says) or the application's main branch, where no such statement exists at all.
     */
    target: AnalysisRunTarget;
    test: { slug: string; plan: string; affectedReason: string };
    provision: { status: string; detail: string; seeded?: string };
    /** A short diff stat for context; the model reads the patch itself with `git diff` over the range below. */
    diffSummary: string;
    /**
     * Present when this run is a SELF-HEAL RE-RUN of a corrected plan. It carries the actual first-pass plan,
     * diagnosis, and proof so the classifier can judge whether the failed repair reveals an invalid test instead
     * of reconstructing that decision from a headline.
     */
    priorPass?: {
        category: string;
        headline: string;
        rootCause?: string;
        plan: string;
        planMismatchNote?: string;
        evidence: Array<{ source: string; detail: string; file?: string; lines?: string; snippet?: string }>;
    };

    /** The repo cloned at the PR head, read through the shared read-only `bash` tool. */
    codebase: Codebase;
    /** The PR's commit range. Rendered into the prompt: the clone has no ref for the base, so the model
     * cannot derive it, and a guessed range silently yields the wrong diff. */
    baseSha: string;
    headSha: string;
    run: RunArtifacts;
    /** Rehydrates one step frame's bytes from its storage key, at `view_step_details` call time. */
    screenshotLoader: ScreenshotLoader;
    /** The preview's configured env-var names (get_preview_env), live or frozen. */
    previewEnv?: PreviewEnvAccess;
    /**
     * A read-only script against the preview's LIVE backend (run_script). Present ONLY when the preview is
     * managed by our previewkit; `undefined` for a self-hosted / non-integrated preview, where there is no
     * backend harness to reach - the tool is then omitted rather than offered and left to fail with confusing
     * credential errors. Its absence is what "cannot query the backend" means to the model.
     */
    previewScript?: PreviewScriptAccess;
    /**
     * The formatted prior-runs baseline (worker injects getPriorRunsHistory + formatPriorRunsBaseline).
     * A function property, not a method: the loop holds it detached, so it must not depend on a `this`.
     */
    loadBaseline: () => Promise<string>;
    /**
     * App logs over the run window, filtered by a regex (worker injects queryLokiLogs). Present ONLY when the
     * preview's Loki stream is reachable (previewkit namespace resolved + LOKI configured); `undefined` for a
     * non-integrated preview, where get_app_logs is omitted instead of returning an "unavailable" note.
     */
    loadAppLogs?: (regex: string) => Promise<string>;
}
