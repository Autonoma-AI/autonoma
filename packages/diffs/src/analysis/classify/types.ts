import type { UploadedVideo } from "@autonoma/ai";
import type { ApplicationArchitecture } from "@autonoma/db";
import type { InspectableStep, ScreenshotLoader } from "../../agents/tools/run-evidence/run-evidence-types";
import type { Codebase } from "../../codebase";

/**
 * The artifacts of the browser run. The recording and the final frame are held in MEMORY as bytes - the
 * generation activity already stored them in S3, and every classification reads both immediately (the four
 * probes watch the video; the prompt inlines the final frame), so the classifier never touches the filesystem.
 */
export interface RunArtifacts {
    success: boolean;
    finishReason: string;
    stepCount: number;
    steps: string[];
    reasoning?: string;
    startEpoch: number;
    endEpoch: number;
    /**
     * The run recording, already in the form the vision models take - the worker uploads it through the
     * uploader its registry entry declares, so nothing here knows or cares whether that is a Files-API URI or
     * inline base64.
     */
    recording?: UploadedVideo;
    finalScreenshot?: Uint8Array;
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

/** Access to the PR's preview environment: its config var names + a read-only script harness against its backend. */
export interface PreviewAccess {
    namespace?: string;
    getEnvVarNames(filter?: string): Promise<string[]>;
    runScript(input: { script: string; packages?: string[] }): Promise<string>;
}

/**
 * Everything one classification needs: the static facts about the run, the handles its tools read
 * through, and the capabilities the worker wires against real infra (Prisma / Loki / k8s / the clone).
 * The three models are NOT here - they are fixed per agent instance, so they live on the constructor.
 */
export interface ClassifierInput {
    appSlug: string;
    prNumber: number;
    test: { slug: string; plan: string; affectedReason: string };
    provision: { status: string; detail: string; seeded?: string };
    /** A short diff stat for context; the model reads the patch itself with `git diff` over the range below. */
    diffSummary: string;
    /** The PR author's stated intent. A hint only - often written at the first commit and never updated, so the
     * diff + code comments are the authoritative intent signal (the prompt says so). */
    prTitle?: string;
    prBody?: string;
    /**
     * Present when this run is a SELF-HEAL RE-RUN of a corrected plan: the prior pass's verdict on the original
     * plan. The prior pass concluded the app was healthy and the TEST was wrong; this run executes the plan it
     * rewrote. The classifier judges the re-run against that conclusion (see the prompt's self-heal section).
     */
    priorPass?: { category: string; headline: string; rootCause?: string };

    /** The repo cloned at the PR head, read through the shared read-only `bash` tool. */
    codebase: Codebase;
    /** The PR's commit range. Rendered into the prompt: the clone has no ref for the base, so the model
     * cannot derive it, and a guessed range silently yields the wrong diff. */
    baseSha: string;
    headSha: string;
    run: RunArtifacts;
    /** Rehydrates one step frame's bytes from its storage key, at `view_step_details` call time. */
    screenshotLoader: ScreenshotLoader;
    /**
     * The PR's preview backend (run_script + get_preview_env). Present ONLY when the preview is managed by our
     * previewkit; `undefined` for a self-hosted / non-integrated preview, where there is no backend harness to
     * reach - the tools are then omitted rather than offered and left to fail with confusing credential errors.
     */
    preview?: PreviewAccess;
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
