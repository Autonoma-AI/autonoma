import type { StepName, StepStatus } from "../core/state";

export type { StepName, StepStatus };

/** Lifecycle of a file in the ARTIFACTS column. */
export type ArtifactStatus = "PENDING" | "WRITING" | "DONE";

/** How the hero panel should render a file's contents. */
export type ContentKind = "markdown" | "json" | "plain";

export interface SubProgress {
    done: number;
    total: number;
    unit: string;
    /** Optional estimate shown alongside the ratio (e.g. "~120 tests" on the
     * tests step, where the final test count isn't known upfront). */
    note?: string;
}

export interface StepNode {
    name: StepName;
    label: string;
    status: StepStatus;
    budgetMs: number;
    budgetMaxMs?: number;
    startedAt?: number;
    endedAt?: number;
    sub?: SubProgress;
    artifactIds: string[];
    /** One-line "why this step exists" shown under the label. */
    why: string;
}

export interface Artifact {
    id: string;
    path: string;
    /** The on-disk file name - the stable contract downstream steps reference. */
    name: string;
    /** Human title for well-known pipeline files ("Knowledge Base"); the
     * primary display label when present. Test files have none. */
    title?: string;
    /** "what this file is" - the why line. */
    description?: string;
    status: ArtifactStatus;
    step: StepName;
    updatedAt: number;
    icon: "doc" | "json" | "test";
}

export type LogLevel = "info" | "success" | "warn" | "error" | "note" | "checkpoint" | "intro" | "outro";

export interface LogEntry {
    id: number;
    level: LogLevel;
    text: string;
    title?: string;
    at: number;
}

/** A row in the ACTIVITY panel (the live agent tool calls). */
export interface ActivityEntry {
    id: number;
    /** mm:ss since run start. */
    time: string;
    /** call verb - colors the row (read / search / write / bash / subagent / ...). */
    call: string;
    /** the argument / target (file path, query, command). */
    arg: string;
    /** right-aligned metric or state, e.g. "412 lines", "failed". */
    metric?: string;
    failed?: boolean;
}

export interface LiveFile {
    artifactId?: string;
    path?: string;
    name?: string;
    kind: ContentKind;
    text: string;
    /** Number of lines in `text`; drives exact scroll bounds. */
    lineCount: number;
    revision: number;
    /** The file is actively being written right now. */
    writingLive: boolean;
    /** Hero auto-switches to the newest written file and tails it. */
    following: boolean;
}

/** The two interactive panels: the file list and the document viewer. The
 * pipeline strip is status display only - selecting a step does nothing. */
export type FocusRegion = "artifacts" | "main";

export interface NavState {
    focus: FocusRegion;
    selectedArtifactIdx: number;
    mainScrollTop: number;
    maxScroll: number;
    /** Visible document rows, reported by the layout - makes unfollow start
     * scrolling from the tail position actually on screen. */
    viewportRows?: number;
    /** Hero text width - the wrap measure for exact scroll bounds. */
    viewportCols?: number;
}

/** Project size signals, filled in as the pipeline learns them. Page count is
 * known after the pages step and predicts the sized steps' budgets. */
export interface ProjectSizes {
    pages?: number;
}

export interface MetaInfo {
    /** Brand-bar title, e.g. "Generating your test suite". */
    title: string;
    project: string;
    version: string;
    /** Trailing note on the subtitle row (e.g. "paused for your review"). */
    stepNote?: string;
}

export interface RunOutcome {
    kind: "complete" | "failed" | "paused";
    message?: string;
}

/* ------------------------------------------------------------------ prompts -- */

export interface SelectOption {
    value: string;
    label: string;
    hint?: string;
}

/** A blocking question the orchestrator pushed; rendered as the docked ACTION
 * REQUIRED panel. One at a time; further requests queue. */
interface PromptBase {
    message: string;
    /** Extra explainer line(s) under the question, wrapped. */
    detail?: string;
    /** Esc resolves {kind:"cancel"} ("go back") - default false: esc is a
     * no-op and the run can only be left via Ctrl+C twice. */
    cancelable?: boolean;
}

export type PromptRequest =
    | ({ kind: "confirm"; initialValue?: boolean } & PromptBase)
    | ({ kind: "select"; options: SelectOption[]; initialValue?: string } & PromptBase)
    | ({ kind: "multiselect"; options: SelectOption[]; initialValues?: string[]; required?: boolean } & PromptBase)
    | ({ kind: "text"; placeholder?: string; defaultValue?: string } & PromptBase);

export type PromptAnswer =
    | { kind: "cancel" }
    | { kind: "confirm"; value: boolean }
    | { kind: "select"; value: string }
    | { kind: "multiselect"; values: string[] }
    | { kind: "text"; value: string };

/** Mutable editing state for the active prompt (cursor, text buffer, checks). */
export interface PromptDraft {
    /** Highlighted option (select/multiselect) or yes/no index (confirm). */
    index: number;
    /** Text buffer + caret (text prompts). */
    text: string;
    cursor: number;
    /** Checked values (multiselect). */
    checked: string[];
    /** Set when submit was rejected (e.g. empty required multiselect). */
    error?: string;
}

export interface PromptState {
    current?: PromptRequest;
    queued: number;
    draft: PromptDraft;
    /** When the active question appeared - drives the wall-vs-agent clock. */
    waitingSince?: number;
}

/** A blocking countdown overlay explaining what is about to happen (the
 * pre-handoff "your terminal is about to switch" moment). Auto-continues when
 * it reaches zero; enter starts immediately. */
export interface CountdownState {
    title: string;
    /** Explainer paragraphs, wrapped at draw time. */
    lines: string[];
    endsAt: number;
}

export interface RunState {
    startedAt: number;
    now: number;
    meta: MetaInfo;
    steps: Record<StepName, StepNode>;
    stepOrder: StepName[];
    currentStep?: StepName;
    /** One-line "what the agent is doing right now" under the hero. */
    activity: string;
    /** ACTIVITY panel rows (newest last). */
    activityFeed: ActivityEntry[];
    artifacts: Record<string, Artifact>;
    artifactOrder: string[];
    log: LogEntry[];
    live: LiveFile;
    nav: NavState;
    finished: boolean;
    outcome?: RunOutcome;
    /** First Ctrl+C landed; a second within the window exits. */
    ctrlCArmed: boolean;
    /** The "?" help modal is showing. */
    helpOpen: boolean;
    /** The blocking-question bridge (docked ACTION REQUIRED panel). */
    prompt: PromptState;
    /** Active pre-handoff countdown overlay, if any. */
    countdown?: CountdownState;
    /** Total ms spent blocked on user questions - excluded from elapsed/ETA. */
    waitedMs: number;
    /** Size signals for the ETA model (sized step budgets). */
    sizes: ProjectSizes;
}
