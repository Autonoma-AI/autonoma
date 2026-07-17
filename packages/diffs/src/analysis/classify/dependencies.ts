import type { LanguageModel } from "ai";

/** Read-only access to the cloned repo at the PR head (backed by the diffs `Codebase` in production). */
export interface CodebaseReader {
    readFile(path: string, fromLine: number, toLine: number): Promise<string>;
    grep(pattern: string): Promise<string>;
    diff(path?: string): Promise<string>;
    /** The changed-files summary (`git diff --stat`) for the PR. */
    diffStat(): Promise<string>;
}

/**
 * The artifacts of the browser run. Media (video / screenshots) is held in MEMORY as bytes rather than on
 * disk - the generation activity already stores them in S3, and the worker fetches them into memory for
 * analysis, so the classifier never touches the filesystem.
 */
export interface RunArtifacts {
    success: boolean;
    finishReason: string;
    stepCount: number;
    steps: string[];
    reasoning?: string;
    startEpoch: number;
    endEpoch: number;
    video?: Uint8Array;
    finalScreenshot?: Uint8Array;
    stepScreenshots: Uint8Array[];
}

/** Access to the PR's preview environment: its config var names + a read-only script harness against its backend. */
export interface PreviewAccess {
    repoFullName?: string;
    namespace?: string;
    getEnvVarNames(filter?: string): Promise<string[]>;
    runScript(input: { script: string; packages?: string[] }): Promise<string>;
}

/**
 * The capabilities the classifier needs, injected so the orchestrator is unit-testable with fakes and the
 * worker wires the real implementations (Prisma, Loki, k8s, S3, the cloned codebase, the models).
 */
export interface ClassifierDeps {
    codebase: CodebaseReader;
    run: RunArtifacts;
    /**
     * The PR's preview backend (run_script + get_preview_env). Present ONLY when the preview is managed by our
     * previewkit; `undefined` for a self-hosted / non-integrated preview, where there is no backend harness to
     * reach - the tools are then omitted rather than offered and left to fail with confusing credential errors.
     */
    preview?: PreviewAccess;
    /** The formatted prior-runs baseline (worker injects getPriorRunsHistory + formatPriorRunsBaseline). */
    loadBaseline(): Promise<string>;
    /**
     * App logs over the run window, filtered by a regex (worker injects queryLokiLogs). Present ONLY when the
     * preview's Loki stream is reachable (previewkit namespace resolved + LOKI configured); `undefined` for a
     * non-integrated preview, where get_app_logs is omitted instead of returning an "unavailable" note.
     */
    loadAppLogs?: (regex: string) => Promise<string>;
    /** The preview's k8s deployment health (worker injects the k8s client). */
    loadDeploymentHealth(): Promise<string>;
    reasoningModel: LanguageModel;
    visionModel: LanguageModel;
    maxSteps: number;
}
