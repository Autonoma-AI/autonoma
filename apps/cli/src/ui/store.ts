import { join } from "node:path";
import { basename, describeArtifact, iconOf, isTestArtifact, kindOf, titleOf } from "./artifacts/registry";
import { renderContentWrapped } from "./components/render-content";
import { agentNow, formatClock } from "./eta";
import { navReducer, type NavAction } from "./nav";
import { answerFor, initialDraft, promptReducer, type PromptAction } from "./prompt";
import { STEP_BUDGET, STEP_ORDER, UI_STEP_LABELS, UI_STEP_WHY } from "./steps";
import type {
    Artifact,
    ArtifactStatus,
    ContentKind,
    LogEntry,
    LogLevel,
    MetaInfo,
    ProjectSizes,
    PromptAnswer,
    PromptRequest,
    RunOutcome,
    RunState,
    StepName,
    StepNode,
    StepStatus,
    SubProgress,
} from "./types";

export type LiveReader = (absPath: string) => Promise<{ text: string; kind: ContentKind } | undefined>;

export interface StoreOptions {
    outputDir: string;
    meta: MetaInfo;
    /** Injected disk reader for the hero panel; omitted in tests (refresh is a no-op). */
    reader?: LiveReader;
}

export interface ActivityInput {
    call: string;
    arg: string;
    metric?: string;
    failed?: boolean;
}

export interface RunStore {
    getState(): RunState;
    subscribe(listener: () => void): () => void;

    // step lifecycle
    startStep(name: StepName): void;
    endStep(name: StepName, status: StepStatus): void;
    setSubProgress(name: StepName, sub: SubProgress | undefined): void;
    setMeta(patch: Partial<MetaInfo>): void;
    /** Record a learned project-size signal (drives sized ETA budgets). */
    setSizes(patch: ProjectSizes): void;

    // activity + logs
    setActivity(text: string): void;
    pushActivity(entry: ActivityInput): void;
    appendLog(entry: { level: LogLevel; text: string; title?: string }): void;

    // artifacts + hero
    noteWrite(relPath: string): void;
    handleFsChange(relPath: string): void;
    setLiveFile(relPath: string, text: string, kind: ContentKind): void;

    // run end
    finish(outcome: RunOutcome): void;

    // nav + clock
    dispatchNav(action: NavAction): void;
    startClock(): void;
    stopClock(): void;

    /** Reflect the Ctrl+C double-press arm state in the controls bar. */
    setCtrlCArmed(armed: boolean): void;

    /** Show/hide the "?" help modal. */
    setHelpOpen(open: boolean): void;

    /**
     * Ask the user a blocking question, rendered as the docked ACTION
     * REQUIRED panel. Resolves when they submit (or cancel). Questions queue;
     * one shows at a time.
     */
    requestPrompt(req: PromptRequest): Promise<PromptAnswer>;
    /** Route an editing key action into the active prompt's draft. */
    dispatchPrompt(action: PromptAction): void;
    /** Submit the active prompt's draft (no-op if invalid; error shows inline). */
    submitPrompt(): void;
    /** Cancel the active prompt (esc). */
    cancelPrompt(): void;

    /**
     * Show a blocking countdown overlay (the pre-handoff explainer). Resolves
     * when the countdown reaches zero or the user presses enter to start now.
     */
    runCountdown(opts: { title: string; lines: string[]; seconds: number }): Promise<void>;
    /** Enter on the countdown: dismiss it and resolve immediately. */
    skipCountdown(): void;
}

const LOG_CAP = 500;
const ACTIVITY_CAP = 200;
/** Coalesce listener notifications so bursts of events repaint once per frame. */
const EMIT_COALESCE_MS = 16;
/** How long after the last write a file keeps its "writing live" indicator. */
const WRITE_SETTLE_MS = 900;
/** Scroll headroom kept below the last line when computing scroll bounds. */
const SCROLL_TAIL_LINES = 5;
// 100ms: the WRITING spinner in the FILES list runs at 200ms/frame (5fps) and
// the strip spinner at 250ms - the clock must tick at least as fast as the
// fastest spinner or frames skip. Ink only rewrites the lines that changed,
// so the cost per tick is a few spinner cells.
const CLOCK_TICK_MS = 100;
/** Terminal bell, rung when a blocking question appears. */
const BELL = "\x07";

function initialSteps(): Record<StepName, StepNode> {
    const make = (name: StepName): StepNode => ({
        name,
        label: UI_STEP_LABELS[name],
        status: "pending",
        budgetMs: STEP_BUDGET[name].ms,
        budgetMaxMs: STEP_BUDGET[name].maxMs,
        artifactIds: [],
        why: UI_STEP_WHY[name],
    });
    // Keyed explicitly (not derived from STEP_ORDER) so the compiler enforces
    // that every StepName is present; a new step fails typecheck here.
    return {
        projectMapper: make("projectMapper"),
        pagesFinder: make("pagesFinder"),
        kb: make("kb"),
        entityAudit: make("entityAudit"),
        scenarioRecipe: make("scenarioRecipe"),
        recipeBuilder: make("recipeBuilder"),
        testGenerator: make("testGenerator"),
    };
}

/**
 * Paths that should never appear as artifacts: dotfiles/state files, anything
 * without a file extension (directories, coarse fs.watch noise), and
 * atomic-write droppings (recipe.json.tmp.<pid>.<hash> - renamed away moments
 * after the watcher sees them, so they'd linger as ghosts in the list).
 */
function isInternal(relPath: string): boolean {
    const name = basename(relPath);
    if (name.startsWith(".") || relPath.startsWith(".")) return true;
    if (!name.includes(".")) return true;
    if (name.includes(".tmp.") || name.endsWith(".tmp")) return true;
    return false;
}

/**
 * Where a new artifact lands in the FILES list. Test files form an
 * alphabetical block (by path, so folders group together) at the top - dozens
 * stream in during the last step and a stable, scannable order beats recency.
 * Everything else stays newest-first below them.
 */
function insertIntoOrder(order: string[], id: string): string[] {
    const tests = order.filter((x) => isTestArtifact(x));
    const others = order.filter((x) => !isTestArtifact(x));
    if (!isTestArtifact(id)) return [...tests, id, ...others];
    const at = tests.findIndex((t) => t.localeCompare(id) > 0);
    if (at === -1) tests.push(id);
    else tests.splice(at, 0, id);
    return [...tests, ...others];
}

export function createStore(opts: StoreOptions): RunStore {
    const now0 = Date.now();
    let state: RunState = {
        startedAt: now0,
        now: now0,
        meta: opts.meta,
        steps: initialSteps(),
        stepOrder: STEP_ORDER,
        activity: "",
        activityFeed: [],
        artifacts: {},
        artifactOrder: [],
        log: [],
        live: {
            kind: "plain",
            text: "",
            lineCount: 0,
            revision: 0,
            writingLive: false,
            following: true,
        },
        nav: {
            // The file list is the natural landing spot: arrows give visible
            // feedback immediately (the document may not even exist yet).
            focus: "artifacts",
            selectedArtifactIdx: 0,
            mainScrollTop: 0,
            maxScroll: 0,
        },
        finished: false,
        ctrlCArmed: false,
        helpOpen: false,
        prompt: { queued: 0, draft: { index: 0, text: "", cursor: 0, checked: [] } },
        waitedMs: 0,
        sizes: {},
    };

    const listeners = new Set<() => void>();
    const promptQueue: { req: PromptRequest; resolve: (a: PromptAnswer) => void }[] = [];
    const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
    let countdownTimer: ReturnType<typeof setTimeout> | undefined;
    let countdownResolve: (() => void) | undefined;
    let clock: ReturnType<typeof setInterval> | undefined;
    let logSeq = 0;
    let activitySeq = 0;

    // Notifications are coalesced: a burst of store updates (a busy agent step
    // registers many tool calls and file writes back to back) triggers one
    // repaint per frame, not one per event. Reads via getState() stay live.
    let emitTimer: ReturnType<typeof setTimeout> | undefined;
    const emit = () => {
        if (emitTimer != null) return;
        emitTimer = setTimeout(() => {
            emitTimer = undefined;
            for (const l of listeners) l();
        }, EMIT_COALESCE_MS);
    };
    const set = (next: RunState) => {
        if (next === state) return;
        state = next;
        emit();
    };

    function absOf(relPath: string): string {
        return join(opts.outputDir, relPath);
    }

    /** Tool events sometimes carry absolute paths; artifacts key on output-relative ones. */
    function relOf(path: string): string {
        if (!path.startsWith(opts.outputDir)) return path;
        return path.slice(opts.outputDir.length).replace(/^\/+/, "");
    }

    function ensureArtifact(relPath: string, status: ArtifactStatus): RunState {
        const id = relPath;
        if (state.artifacts[id]) return state;
        const step = state.currentStep ?? state.stepOrder[0]!;
        // A registration that lands after its step settled (the fs watcher
        // debounces past endStep) must not show as WRITING forever.
        const stepDone = state.steps[step].status === "done";
        const art: Artifact = {
            id,
            path: relPath,
            name: basename(relPath),
            title: titleOf(relPath),
            description: describeArtifact(relPath),
            status: stepDone && status === "WRITING" ? "DONE" : status,
            step,
            updatedAt: state.now,
            icon: iconOf(relPath),
        };
        return {
            ...state,
            artifacts: { ...state.artifacts, [id]: art },
            artifactOrder: insertIntoOrder(state.artifactOrder, id),
            steps: {
                ...state.steps,
                [step]: { ...state.steps[step], artifactIds: [...state.steps[step].artifactIds, id] },
            },
        };
    }

    async function refresh(relPath: string) {
        if (opts.reader == null) return;
        const content = await opts.reader(absOf(relPath));
        if (content == null) return;
        // Only repaint the hero if this file is the one being shown.
        if (state.live.artifactId === relPath) {
            setLiveText(relPath, content.text, content.kind);
        }
    }

    function setLiveText(relPath: string, text: string, kind: ContentKind) {
        // Wrap-aware when the layout has reported its measure - scroll bounds
        // must count folded lines, not raw ones.
        const cols = state.nav.viewportCols;
        const lineCount =
            cols != null ? renderContentWrapped(text, kind, basename(relPath), cols).length : text.split("\n").length;
        set({
            ...state,
            live: {
                ...state.live,
                artifactId: relPath,
                path: relPath,
                name: basename(relPath),
                kind,
                text,
                lineCount,
                revision: state.live.revision + 1,
            },
            nav: { ...state.nav, maxScroll: Math.max(0, lineCount - SCROLL_TAIL_LINES) },
        });
    }

    function scheduleSettle(relPath: string) {
        const prev = settleTimers.get(relPath);
        if (prev) clearTimeout(prev);
        settleTimers.set(
            relPath,
            setTimeout(() => {
                settleTimers.delete(relPath);
                let next = state;
                // WRITING means "being written right now": once the write
                // quiets down the file is DONE, even mid-step - a step that
                // writes dozens of files (tests) must not leave them all
                // glowing WRITING for an hour. A later update flips it back.
                const art = next.artifacts[relPath];
                if (art != null && art.status === "WRITING") {
                    next = { ...next, artifacts: { ...next.artifacts, [relPath]: { ...art, status: "DONE" } } };
                }
                if (next.live.artifactId === relPath && next.live.writingLive) {
                    next = { ...next, live: { ...next.live, writingLive: false } };
                }
                set(next);
            }, WRITE_SETTLE_MS),
        );
    }

    const store: RunStore = {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },

        startStep(name) {
            set({
                ...state,
                currentStep: name,
                // Agent-time, not wall time: waiting on a question must not
                // count against the step's budget.
                steps: {
                    ...state.steps,
                    [name]: { ...state.steps[name], status: "running", startedAt: agentNow(state) },
                },
            });
        },

        endStep(name, status) {
            // Settle the step's artifacts to DONE when it completes successfully.
            const artifacts = { ...state.artifacts };
            if (status === "done") {
                for (const id of state.steps[name].artifactIds) {
                    const art = artifacts[id];
                    if (art) artifacts[id] = { ...art, status: "DONE" };
                }
            }
            set({
                ...state,
                artifacts,
                steps: { ...state.steps, [name]: { ...state.steps[name], status, endedAt: agentNow(state) } },
            });
        },

        setSubProgress(name, sub) {
            set({ ...state, steps: { ...state.steps, [name]: { ...state.steps[name], sub } } });
        },

        setMeta(patch) {
            set({ ...state, meta: { ...state.meta, ...patch } });
        },

        setSizes(patch) {
            set({ ...state, sizes: { ...state.sizes, ...patch } });
        },

        setActivity(text) {
            if (text === state.activity) return;
            set({ ...state, activity: text });
        },

        pushActivity(entry) {
            const e = {
                id: activitySeq++,
                time: formatClock(state.now - state.startedAt),
                call: entry.call,
                arg: entry.arg,
                metric: entry.metric,
                failed: entry.failed,
            };
            const feed =
                state.activityFeed.length >= ACTIVITY_CAP
                    ? [...state.activityFeed.slice(1), e]
                    : [...state.activityFeed, e];
            set({ ...state, activityFeed: feed });
        },

        appendLog(entry) {
            const e: LogEntry = {
                id: logSeq++,
                level: entry.level,
                text: entry.text,
                title: entry.title,
                at: state.now,
            };
            const log = state.log.length >= LOG_CAP ? [...state.log.slice(1), e] : [...state.log, e];
            set({ ...state, log });
            // The dashboard has no raw-log panel; surface the levels a user must
            // not miss as activity rows so they show up in the ACTIVITY feed.
            const surfaced: LogLevel[] = ["success", "warn", "error", "checkpoint"];
            if (surfaced.includes(entry.level)) {
                store.pushActivity({ call: entry.level, arg: entry.text, failed: entry.level === "error" });
            }
        },

        noteWrite(path) {
            const relPath = relOf(path);
            if (isInternal(relPath)) return;
            let next = ensureArtifact(relPath, "WRITING");
            const art = next.artifacts[relPath]!;
            next = {
                ...next,
                artifacts: { ...next.artifacts, [relPath]: { ...art, status: "WRITING", updatedAt: next.now } },
            };
            // Follow the newest file in the hero unless the user pinned one.
            // The list cursor rides along so browsing starts from the newest.
            if (next.live.following) {
                next = {
                    ...next,
                    live: {
                        ...next.live,
                        artifactId: relPath,
                        path: relPath,
                        name: basename(relPath),
                        kind: kindOf(relPath),
                        writingLive: true,
                    },
                    nav: { ...next.nav, selectedArtifactIdx: Math.max(0, next.artifactOrder.indexOf(relPath)) },
                };
            } else if (next.live.artifactId === relPath) {
                next = { ...next, live: { ...next.live, writingLive: true } };
            }
            set(next);
            void refresh(relPath);
            scheduleSettle(relPath);
        },

        handleFsChange(relPath) {
            // A change on disk IS a write, wherever it came from - a custom
            // tool (register_pages), the coding agent, anything. Route it
            // through noteWrite so WRITING status, the settle timer, and
            // follow-the-newest behave identically to tool-driven writes.
            store.noteWrite(relPath);
        },

        setLiveFile(relPath, text, kind) {
            setLiveText(relPath, text, kind);
        },

        finish(outcome) {
            store.stopClock();
            set({
                ...state,
                finished: true,
                outcome,
                currentStep: undefined,
                live: { ...state.live, writingLive: false },
            });
        },

        dispatchNav(action) {
            const before = state.live.artifactId;
            set(navReducer(state, action));
            const after = state.live.artifactId;
            if (after != null && after !== before) void refresh(after);
            if (action.type === "toggleFollow" && state.live.following) {
                // "Newest" is by write time, not list position - tests sort
                // alphabetically, so the latest write can sit mid-list.
                const arts = state.artifactOrder
                    .map((id) => state.artifacts[id])
                    .filter((a): a is Artifact => a != null);
                const newest = arts.reduce<Artifact | undefined>(
                    (a, b) => (a == null || b.updatedAt > a.updatedAt ? b : a),
                    undefined,
                );
                if (newest != null && newest.id !== state.live.artifactId) {
                    set({
                        ...state,
                        live: {
                            ...state.live,
                            artifactId: newest.id,
                            path: newest.path,
                            name: newest.name,
                            kind: kindOf(newest.path),
                        },
                        nav: { ...state.nav, selectedArtifactIdx: state.artifactOrder.indexOf(newest.id) },
                    });
                    void refresh(newest.id);
                }
            }
        },

        startClock() {
            if (clock != null) return;
            clock = setInterval(() => set({ ...state, now: Date.now() }), CLOCK_TICK_MS);
        },
        stopClock() {
            if (clock != null) clearInterval(clock);
            clock = undefined;
        },

        setCtrlCArmed(isArmed) {
            if (isArmed === state.ctrlCArmed) return;
            set({ ...state, ctrlCArmed: isArmed });
        },

        setHelpOpen(open) {
            if (open === state.helpOpen) return;
            set({ ...state, helpOpen: open });
        },

        requestPrompt(req) {
            return new Promise<PromptAnswer>((resolve) => {
                promptQueue.push({ req, resolve });
                if (state.prompt.current == null) activateNextPrompt();
                else set({ ...state, prompt: { ...state.prompt, queued: promptQueue.length - 1 } });
            });
        },

        dispatchPrompt(action) {
            const current = state.prompt.current;
            if (current == null) return;
            set({ ...state, prompt: { ...state.prompt, draft: promptReducer(current, state.prompt.draft, action) } });
        },

        submitPrompt() {
            const current = state.prompt.current;
            if (current == null) return;
            const result = answerFor(current, state.prompt.draft);
            if ("error" in result) {
                set({ ...state, prompt: { ...state.prompt, draft: { ...state.prompt.draft, error: result.error } } });
                return;
            }
            settlePrompt(result);
        },

        cancelPrompt() {
            const current = state.prompt.current;
            if (current == null) return;
            if (current.cancelable !== true) {
                // Esc must never silently kill the run; tell the user how to leave.
                set({
                    ...state,
                    prompt: {
                        ...state.prompt,
                        draft: { ...state.prompt.draft, error: "This question needs an answer - Ctrl+C twice quits" },
                    },
                });
                return;
            }
            settlePrompt({ kind: "cancel" });
        },

        runCountdown({ title, lines, seconds }) {
            return new Promise<void>((resolve) => {
                countdownResolve = resolve;
                if (process.stdout.isTTY) process.stdout.write(BELL);
                set({ ...state, countdown: { title, lines, endsAt: state.now + seconds * 1000 } });
                countdownTimer = setTimeout(() => store.skipCountdown(), seconds * 1000);
            });
        },

        skipCountdown() {
            if (countdownTimer != null) clearTimeout(countdownTimer);
            countdownTimer = undefined;
            const resolve = countdownResolve;
            countdownResolve = undefined;
            if (state.countdown != null) set({ ...state, countdown: undefined });
            resolve?.();
        },
    };

    function activateNextPrompt(): void {
        const next = promptQueue[0];
        if (next == null) {
            set({ ...state, prompt: { ...state.prompt, current: undefined, queued: 0, waitingSince: undefined } });
            return;
        }
        // An audible nudge: the run blocks until the user answers.
        if (process.stdout.isTTY) process.stdout.write(BELL);
        set({
            ...state,
            prompt: {
                current: next.req,
                queued: promptQueue.length - 1,
                draft: initialDraft(next.req),
                waitingSince: state.prompt.waitingSince ?? state.now,
            },
        });
    }

    function settlePrompt(answer: PromptAnswer): void {
        const head = promptQueue.shift();
        if (head == null) return;
        // Bank the time this question was on screen - elapsed/ETA exclude it.
        const since = state.prompt.waitingSince;
        if (since != null) {
            state = {
                ...state,
                waitedMs: state.waitedMs + Math.max(0, state.now - since),
                prompt: { ...state.prompt, waitingSince: undefined },
            };
        }
        activateNextPrompt();
        head.resolve(answer);
    }

    return store;
}

/* --------------------------------------------------------------- singleton -- */

let active: RunStore | undefined;

/**
 * The store the orchestrator/agents/loggers push into. Set only while the
 * interactive TUI is mounted - headless runs keep it unset so every consumer
 * falls back to plain line output.
 */
export function setActiveStore(store: RunStore | undefined): void {
    active = store;
}

export function getActiveStore(): RunStore | undefined {
    return active;
}
