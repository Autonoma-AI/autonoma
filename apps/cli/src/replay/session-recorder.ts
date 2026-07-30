import { randomUUID } from "node:crypto";
import { debugLog } from "../core/debug";
import { getPostHogConfig } from "../core/posthog";
import { getSession } from "../core/session";
import type { TermSize } from "../ui/hooks/useTerminalSize";
import type { RunState } from "../ui/types";
import { ansiToRows } from "./ansi-to-rows";
import { FrameDiffer, KEY_TARGET_ID } from "./frame-differ";
import { HeadlessRenderer } from "./headless-renderer";
import { ReplayTransport } from "./replay-transport";
import type { ReplayEvent } from "./types";

/**
 * The dashboard repaints up to 30 times a second; a replay does not need that.
 * Two frames a second keeps spinners and progress legible while cutting the
 * off-screen render work and the mutation volume by an order of magnitude.
 */
const FRAME_INTERVAL_MS = 500;

/** Upload on a timer as well as on size, so an interrupted run keeps its tail. */
const UPLOAD_INTERVAL_MS = 10_000;

/** Approximate monospace cell size, used only to give the player a viewport. */
const CELL_WIDTH_PX = 7.8;
const CELL_HEIGHT_PX = 17.6;
const VIEWPORT_PADDING_PX = 44;

export interface SessionRecorderOptions {
    size: TermSize;
}

/**
 * Records the planner dashboard as a PostHog session replay.
 *
 * Frames come from an off-screen render of the same <App> the user sees, are
 * converted to a synthetic DOM, and are diffed row by row so only what changed
 * is uploaded. Keystrokes are emitted separately as rrweb input events: PostHog
 * derives the active/inactive split from interaction events alone, so without
 * them a run of pure repaints reads as entirely idle.
 */
export class SessionRecorder {
    public readonly sessionId: string;

    private readonly renderer: HeadlessRenderer;
    private readonly differ = new FrameDiffer();
    private readonly transport: ReplayTransport;
    private readonly startedAt = Date.now();

    private lastFrameAt = 0;
    private pendingFrame?: ReturnType<typeof setTimeout>;
    private uploadTimer?: ReturnType<typeof setInterval>;
    private latestState?: RunState;
    private started = false;
    private stopped = false;

    constructor(private readonly options: SessionRecorderOptions) {
        const posthog = getPostHogConfig();
        const session = getSession();
        // The run id doubles as the PostHog session id for events and logs; reuse
        // it so a recording, its events and its logs all resolve to one another
        // instead of the replay sitting under an id nothing else knows about.
        this.sessionId = session.runId;
        this.renderer = new HeadlessRenderer(options.size);
        this.transport = new ReplayTransport({
            apiKey: posthog.key,
            host: posthog.host,
            distinctId: session.distinctId,
            sessionId: this.sessionId,
            windowId: randomUUID(),
        });
        this.uploadTimer = setInterval(() => this.transport.flush(), UPLOAD_INTERVAL_MS);
        this.uploadTimer.unref?.();
        debugLog("Session replay started", { sessionId: this.sessionId });
    }

    /**
     * Offer the current state for capture. Cheap to call on every store change:
     * frames are rate limited, and a change arriving inside the window is
     * captured by a trailing timer so the final state is never lost.
     */
    public captureFrame(state: RunState): void {
        if (this.stopped || this.transport.isExhausted) return;
        this.latestState = state;

        const elapsed = Date.now() - this.lastFrameAt;
        if (elapsed >= FRAME_INTERVAL_MS) {
            this.emitFrame();
            return;
        }
        if (this.pendingFrame != null) return;
        this.pendingFrame = setTimeout(() => {
            this.pendingFrame = undefined;
            this.emitFrame();
        }, FRAME_INTERVAL_MS - elapsed);
        this.pendingFrame.unref?.();
    }

    /**
     * Record a keystroke. The label is a key name ("enter", "up") or the typed
     * character, never assembled into the user's actual input beyond what is
     * already visible in the frames.
     */
    public recordKeystroke(label: string): void {
        if (this.stopped || !this.started || this.transport.isExhausted) return;
        this.transport.add([
            {
                type: 3,
                timestamp: Date.now(),
                data: { source: 5, id: KEY_TARGET_ID, text: label, isChecked: false },
            },
        ]);
    }

    /**
     * The dashboard is unmounted while the coding agent owns the terminal. The
     * next frame after that must be a full snapshot, since the DOM the player
     * holds is no longer what we diffed against.
     */
    public invalidate(): void {
        this.differ.invalidate();
    }

    public stop(): void {
        if (this.stopped) return;
        this.stopped = true;
        if (this.pendingFrame != null) clearTimeout(this.pendingFrame);
        if (this.uploadTimer != null) clearInterval(this.uploadTimer);
        if (this.latestState != null) this.emitFrame(true);
        this.transport.flush();
        this.renderer.dispose();
        debugLog("Session replay stopped", { sessionId: this.sessionId });
    }

    private emitFrame(force = false): void {
        const state = this.latestState;
        if (state == null) return;
        if (!force && this.stopped) return;
        this.lastFrameAt = Date.now();

        try {
            const rows = ansiToRows(this.renderer.frame(state));
            const events: ReplayEvent[] = [];
            if (!this.started) {
                this.started = true;
                events.push(this.metaEvent(rows.length));
            }
            events.push(...this.differ.next(rows, Date.now()));
            this.transport.add(events);
        } catch (err) {
            // A capture failure must never take the run with it.
            debugLog("Session replay frame capture failed", { err });
        }
    }

    private metaEvent(rowCount: number): ReplayEvent {
        return {
            type: 4,
            timestamp: this.startedAt,
            data: {
                href: `terminal://autonoma-planner/${this.options.size.columns}x${this.options.size.rows}`,
                width: Math.round(this.options.size.columns * CELL_WIDTH_PX + VIEWPORT_PADDING_PX),
                height: Math.round(rowCount * CELL_HEIGHT_PX + VIEWPORT_PADDING_PX),
            },
        };
    }
}
