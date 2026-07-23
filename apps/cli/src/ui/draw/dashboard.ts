import { titleOf } from "../artifacts/registry";
import { renderContentWrapped } from "../components/render-content";
import { agentNow } from "../eta";
import type { Grid } from "../grid";
import { allArtifacts } from "../nav";
import { STEP_DOCS, STEP_INTROS, STEP_OUTPUTS } from "../steps";
import { theme } from "../theme";
import type { ActivityEntry, Artifact, RunState, StepNode } from "../types";
import { drawHints, drawSpans, drawTopBar, type Hint } from "./chrome";
import { drawCountdownModal } from "./countdown";
import { drawHelpModal } from "./help";
import { drawPromptModal } from "./prompt";
import { wrapPlain } from "./wrap";

/**
 * Layout, top to bottom: top bar (rows 0-2), the horizontal pipeline strip
 * (status display only - not focusable), then two interactive panels side by
 * side (file list | document viewer), the ACTIVITY feed, and the controls bar.
 */
const STRIP_Y = 3;
const PANEL_TOP = 6;
const ACTIVITY_ROWS = 11;
const HINTS_ROWS = 2;

/** File-list column: matches the old artifacts column's size. */
const FILES_MIN_W = 41;
const FILES_FRACTION = 0.27;

/** Readable measure for centered empty-state copy. */
const EMPTY_BODY_MAX_W = 72;

/** Longest status cell ("● WRITING"); reserves the gap between name and status. */
const STATUS_CELL_W = 11;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Both must be multiples of the store clock tick (100ms) so frames only ever
 * advance forward - a mismatched period makes a spinner crawl or run backwards. */
const SPINNER_STEP_MS = 250;
/** The WRITING spinner in the FILES list - deliberately faster (5fps): it marks
 * the file being produced right now. */
const WRITING_SPINNER_MS = 200;

interface Geometry {
    /** x of the vertical divider between the file list and the viewer. */
    div: number;
    heroX: number;
    heroW: number;
}

function computeGeometry(w: number): Geometry {
    const div = Math.max(FILES_MIN_W, Math.round(w * FILES_FRACTION));
    const heroX = div + 2;
    return { div, heroX, heroW: w - heroX - 2 };
}

function activityRowsFor(h: number): number {
    return Math.max(4, Math.min(ACTIVITY_ROWS, h - HINTS_ROWS - PANEL_TOP - 10));
}

/**
 * How many document lines the viewer shows at a grid size. The nav reducer
 * needs this so unfollowing starts scrolling from the tail actually on screen.
 */
export function heroViewportRows(_width: number, height: number): number {
    const panelBottom = height - HINTS_ROWS - activityRowsFor(height);
    return Math.max(1, panelBottom - 1 - (PANEL_TOP + 2));
}

/** Hero text width at a grid width - the wrap measure the store needs for
 * exact scroll bounds. */
export function heroViewportCols(width: number): number {
    return computeGeometry(width).heroW;
}

/* ---------------------------------------------------------- pipeline strip -- */

/** The strip's sub-progress label: "28/41 nodes · ~120 tests". */
function subLabel(sub: StepNode["sub"]): string | undefined {
    if (sub == null) return undefined;
    const base = `${sub.done}/${sub.total} ${sub.unit}`;
    return sub.note != null ? `${base} · ${sub.note}` : base;
}

function stepGlyph(step: StepNode, now: number): { ch: string; color: string } {
    if (step.status === "done") return { ch: "✓", color: theme.accent };
    if (step.status === "running") {
        const frame = SPINNER_FRAMES[Math.floor(now / SPINNER_STEP_MS) % SPINNER_FRAMES.length]!;
        return { ch: frame, color: theme.accent };
    }
    if (step.status === "failed") return { ch: "✗", color: theme.red };
    if (step.status === "paused") return { ch: "‖", color: theme.amber };
    return { ch: "○", color: theme.tertiary };
}

/**
 * The pipeline as one horizontal row of steps. Labels shrink (longest first)
 * until the strip fits the terminal width.
 */
function drawPipelineStrip(g: Grid, state: RunState, y: number): void {
    const W = g.w;
    const GAP = 3;

    const items = state.stepOrder.map((name) => {
        const step = state.steps[name];
        return {
            step,
            label: step.label,
            // The unit matters: the tests step counts NODES (pages/features),
            // not tests - the test count per node is only decided as each one
            // is read, so a bare 28/41 would read as the wrong thing. An
            // optional note carries the estimated final count (~120 tests).
            sub: subLabel(step.sub),
        };
    });

    const itemWidth = (item: (typeof items)[number]) =>
        2 + item.label.length + (item.sub != null ? item.sub.length + 1 : 0);
    const totalWidth = () => items.reduce((n, item) => n + itemWidth(item), 0) + GAP * (items.length - 1) + 2;

    while (totalWidth() > W) {
        const longest = items.reduce((a, b) => (a.label.length >= b.label.length ? a : b));
        if (longest.label.length <= 7) break;
        longest.label = longest.label.slice(0, longest.label.length - 2).trimEnd() + "…";
    }

    let x = 1;
    items.forEach((item, i) => {
        const active = item.step.status === "running";
        const w = itemWidth(item);
        if (active) g.fillBg(x - 1, y, w + 2, theme.activeBg);
        const bg = active ? theme.activeBg : undefined;
        const gl = stepGlyph(item.step, agentNow(state));
        g.text(x, y, gl.ch, { color: gl.color, bg });
        const labelColor = active
            ? theme.accent
            : item.step.status === "pending"
              ? theme.secondary
              : item.step.status === "failed"
                ? theme.red
                : theme.text;
        g.text(x + 2, y, item.label, { color: labelColor, bold: active, bg });
        if (item.sub != null) {
            g.text(x + 2 + item.label.length + 1, y, item.sub, {
                color: active ? theme.accent : theme.tertiary,
                bg,
            });
        }
        x += w + GAP;
        if (i < items.length - 1) g.text(x - 2, y, "›", { color: theme.faint });
    });

    g.hline(0, y + 1, W, "─", theme.borderChrome);
}

/* ---------------------------------------------------------------- file list -- */

function artifactStatusCell(a: Artifact, now: number): { t: string; color: string } {
    switch (a.status) {
        case "DONE":
            return { t: "DONE", color: theme.tertiary };
        case "WRITING": {
            const frame = SPINNER_FRAMES[Math.floor(now / WRITING_SPINNER_MS) % SPINNER_FRAMES.length]!;
            return { t: `${frame} WRITING`, color: theme.sky };
        }
        default:
            return { t: "PENDING", color: theme.faint };
    }
}

function drawFiles(g: Grid, geo: Geometry, state: RunState, base: number, bottom: number): void {
    const list = allArtifacts(state);
    const focused = state.nav.focus === "artifacts";

    g.text(1, base - 2, "FILES", { color: focused ? theme.accent : theme.tertiary });
    // Just the count: files only enter this list once written, so any
    // done-of-total form here reads N of N forever. Real progress toward a
    // planned total lives in the pipeline strip's sub-progress.
    g.textRight(geo.div - 2, base - 2, `${list.length} ${list.length === 1 ? "file" : "files"}`, {
        color: theme.tertiary,
    });

    const maxRows = Math.max(1, Math.floor((bottom - base) / 3));

    // Keep the SELECTION in view. While following, the cursor rides the
    // newest write (which sits mid-list once tests sort alphabetically);
    // while browsing, it's wherever the user put it. Either way the list
    // never jumps away from the row that matters.
    const showCursor = focused || !state.live.following;
    let start = 0;
    const sel = state.nav.selectedArtifactIdx;
    if (sel < start) start = sel;
    else if (sel >= start + maxRows) start = sel - maxRows + 1;
    const visible = list.slice(start, start + maxRows);

    visible.forEach((a, i) => {
        const row = base + i * 3;
        const active = a.status === "WRITING";
        const selected = showCursor && start + i === state.nav.selectedArtifactIdx;
        // ONE background per row: the fill and every text span must use the
        // same value, or the row renders as mismatched patches behind the
        // text. Selection wins over the writing tint.
        const rowBg = selected ? theme.selectionBg : active ? theme.activeBg : undefined;
        if (rowBg != null) {
            for (let y = row - 1; y <= row + 1; y++) g.fillBg(0, y, geo.div, rowBg);
        }
        const bg = rowBg;
        if (selected) g.set(0, row, "›", { color: theme.accent, bold: true, bg });
        const icon = a.icon === "json" ? "{}" : "▤";
        g.text(2, row, icon, { color: theme.tertiary, bg });
        // Well-known files show their human title as the primary label with
        // the on-disk name demoted to the detail line; tests keep their
        // (already descriptive) file name up top.
        const label = a.title ?? a.name;
        const detail = a.title != null ? [a.name, a.description].filter((s) => s != null).join(" · ") : a.description;
        const nameColor = active || a.status === "DONE" ? theme.text : theme.secondary;
        const nameMax = geo.div - 2 - STATUS_CELL_W - 2 - 5;
        const shown = label.length > nameMax ? label.slice(0, Math.max(1, nameMax - 1)) + "…" : label;
        g.text(5, row, shown, { color: nameColor, bold: active || selected, bg });
        const st = artifactStatusCell(a, agentNow(state));
        g.textRight(geo.div - 2, row, st.t, { color: st.color, bg });
        if (detail != null && detail !== "") {
            g.text(5, row + 1, detail.slice(0, geo.div - 6), {
                color: active || selected ? theme.secondary : theme.tertiary,
                bg,
            });
        }
    });
}

/* ------------------------------------------------------------------- viewer -- */

function drawHeroHeader(g: Grid, geo: Geometry, state: RunState, y: number): void {
    const { live } = state;
    let x = geo.heroX;
    if (live.path == null) {
        g.text(x, y, "▤  no document yet", { color: theme.tertiary });
        return;
    }
    if (live.writingLive) {
        g.text(x, y, "● ", { color: theme.accent });
        x += 2;
    }
    g.text(x, y, live.kind === "json" ? "{} " : "▤  ", { color: theme.tertiary });
    x += 3;
    // Human title first; the on-disk name follows dim so the file stays findable.
    const title = live.path != null ? titleOf(live.path) : undefined;
    g.text(x, y, title ?? live.name ?? "", { color: theme.text, bold: true });
    x += (title ?? live.name ?? "").length;
    if (title != null && live.name != null) {
        g.text(x + 2, y, live.name, { color: theme.tertiary });
        x += live.name.length + 2;
    }
    if (live.writingLive) g.text(x + 3, y, "● WRITING LIVE", { color: theme.sky });
    else g.text(x + 3, y, "✓ COMPLETE", { color: theme.green });

    const kb = `${(live.text.length / 1024).toFixed(1)} KB`;
    const right = live.writingLive
        ? live.following
            ? { t: "↓ FOLLOWING LATEST", c: theme.accent }
            : { t: "PAUSED · press f to follow", c: theme.tertiary }
        : live.following
          ? { t: `scroll to read · ${kb}`, c: theme.tertiary }
          : { t: `pinned · f follows latest · ${kb}`, c: theme.sky };
    g.textRight(geo.heroX + geo.heroW - 1, y, right.t, { color: right.c });
}

/**
 * While a step runs but no document is showing, the viewer explains the step:
 * where we are in the pipeline, what is happening and why, what file it will
 * produce, and where to read more. Left-aligned in a centered block - this is
 * a paragraph, not a caption.
 */
function drawHeroEmpty(g: Grid, geo: Geometry, state: RunState, y0: number, bottom: number): void {
    const name = state.currentStep;
    const step = name != null ? state.steps[name] : undefined;
    const blockW = Math.min(EMPTY_BODY_MAX_W, geo.heroW - 4);
    const x0 = geo.heroX + Math.max(1, Math.floor((geo.heroW - blockW) / 2));
    const clip = (t: string) => (t.length > blockW ? t.slice(0, blockW - 1) + "…" : t);

    if (name == null || step == null) {
        const y = Math.floor((y0 + bottom) / 2);
        g.text(x0, y, "Starting up...", { color: theme.secondary });
        return;
    }

    const stepIdx = state.stepOrder.indexOf(name);
    const introLines = wrapPlain(STEP_INTROS[name], blockW);
    const outputLines = wrapPlain(STEP_OUTPUTS[name], blockW - 11);
    const docsUrl = STEP_DOCS[name];

    const hasFiles = state.artifactOrder.length > 0;
    const blockH =
        2 + 2 + introLines.length + 1 + outputLines.length + (docsUrl != null ? 1 : 0) + 2 + (hasFiles ? 1 : 0);
    let y = Math.max(y0, Math.floor((y0 + bottom - blockH) / 2));

    g.text(x0, y, `STEP ${stepIdx + 1} OF ${state.stepOrder.length}`, { color: theme.tertiary });
    y += 1;
    g.text(x0, y, clip(step.label), { color: theme.text, bold: true });
    y += 2;
    for (const line of introLines) {
        g.text(x0, y, line, { color: theme.secondary });
        y++;
    }
    y++;
    g.text(x0, y, "Produces", { color: theme.accent, bold: true });
    outputLines.forEach((line, i) => {
        g.text(x0 + 11, y + i, line, { color: theme.text });
    });
    y += outputLines.length;
    if (docsUrl != null) {
        g.text(x0, y, "Read more", { color: theme.accent, bold: true });
        g.text(x0 + 11, y, clip(docsUrl.replace(/^https?:\/\//, "")), { color: theme.sky });
        y++;
    }
    // The follow state, impossible to miss: either we're live-tailing (the
    // next write opens here) or a prominent hint says how to turn that on.
    y++;
    if (state.live.following) {
        g.text(x0, y, "●", { color: theme.accent });
        g.text(x0 + 2, y, clip("following - the newest file opens here as it's written"), {
            color: theme.accent,
            bold: true,
        });
    } else {
        g.text(x0, y, " f ", { bg: theme.accent, color: theme.onAccent, bold: true });
        g.text(x0 + 4, y, clip("follow the newest file as it's written"), { color: theme.text, bold: true });
    }
    if (hasFiles) {
        y++;
        g.text(x0, y, clip("enter or → on a file in the list to read it here"), { color: theme.tertiary });
    }
}

function drawHeroBody(g: Grid, geo: Geometry, state: RunState, y0: number, bottom: number): void {
    const { live } = state;
    if (live.path == null) {
        drawHeroEmpty(g, geo, state, y0, bottom);
        return;
    }
    const reserve = live.writingLive ? 1 : 0;
    const rows = Math.max(1, bottom - y0 - reserve);
    const lines = renderContentWrapped(live.text, live.kind, live.name, geo.heroW);
    const maxTop = Math.max(0, lines.length - rows);
    const top = live.following ? maxTop : Math.max(0, Math.min(state.nav.mainScrollTop, maxTop));
    const visible = lines.slice(top, top + rows);
    visible.forEach((spans, i) => drawSpans(g, geo.heroX, y0 + i, spans, geo.heroW));
    if (live.writingLive) {
        const cy = y0 + rows;
        g.text(geo.heroX, cy, "▍ ", { color: theme.sky });
        const act = (state.activity || "writing...").slice(0, geo.heroW - 4);
        g.text(geo.heroX + 2, cy, act, { color: theme.secondary });
        g.set(geo.heroX + 2 + act.length + 1, cy, "█", { color: theme.accent });
    }
}

/* ----------------------------------------------------------------- activity -- */

function callColor(call: string): string {
    if (call === "read") return theme.sky;
    if (call === "glob" || call === "grep" || call === "search") return theme.violet;
    if (call === "write" || call === "test") return theme.accent;
    if (call === "bash") return theme.orange;
    if (call === "subagent") return theme.violet;
    if (call === "agent") return theme.tertiary;
    if (call === "done" || call === "success") return theme.green;
    if (call === "warn" || call === "checkpoint") return theme.amber;
    if (call === "error") return theme.red;
    return theme.secondary;
}

function drawActivity(g: Grid, state: RunState, top: number, h: number): void {
    const W = g.w;
    g.hline(0, top, W, "─", theme.borderChrome);
    g.text(0, top + 1, "● ", { color: theme.accent });
    g.text(2, top + 1, "ACTIVITY", { color: theme.tertiary });
    g.text(11, top + 1, "live agent calls", { color: theme.secondary });
    const stateLabel = state.finished
        ? "idle"
        : state.prompt.current != null
          ? "waiting for you"
          : state.currentStep != null
            ? "streaming"
            : "waiting";
    g.textRight(W - 1, top + 1, stateLabel, { color: theme.tertiary });

    const rows = Math.max(1, h - 2);
    const entries = state.activityFeed.slice(-rows);
    entries.forEach((e: ActivityEntry, i) => {
        const y = top + 2 + i;
        const newest = i === entries.length - 1 && !state.finished;
        if (newest) g.fillBg(0, y, W, theme.activeBg);
        const bg = newest ? theme.activeBg : undefined;
        g.text(0, y, e.time, { color: theme.tertiary, bg });
        g.text(10, y, e.call.slice(0, 11), { color: callColor(e.call), bold: true, bg });
        g.text(22, y, e.arg.slice(0, Math.max(0, W - 40)), { color: theme.text, bg });
        if (e.failed) g.textRight(W - 1, y, "✗ failed", { color: theme.red, bg });
        else if (e.metric != null) g.textRight(W - 1, y, e.metric, { color: theme.tertiary, bg });
    });
}

/* ---------------------------------------------------------------- dashboard -- */

export function drawDashboard(g: Grid, state: RunState): void {
    const W = g.w;
    const H = g.h;
    drawTopBar(g, state);
    const geo = computeGeometry(W);

    drawPipelineStrip(g, state, STRIP_Y + 1);

    const activityRows = activityRowsFor(H);
    const panelBottom = H - HINTS_ROWS - activityRows; // first row of the bottom region

    g.vline(geo.div, PANEL_TOP, panelBottom - PANEL_TOP, "│", theme.borderChrome);

    drawHeroHeader(g, geo, state, PANEL_TOP);
    g.hline(geo.heroX, PANEL_TOP + 1, geo.heroW, "─", theme.border);

    drawFiles(g, geo, state, PANEL_TOP + 2, panelBottom - 1);
    drawHeroBody(g, geo, state, PANEL_TOP + 2, panelBottom - 1);

    const promptActive = state.prompt.current != null;
    drawActivity(g, state, panelBottom, activityRows);

    // Ctrl+C routes to interruptPress in every mode (modal or not), so the
    // armed state must show everywhere - a press whose feedback never appears
    // reads as a dead key.
    const exitHint: Hint = state.ctrlCArmed
        ? { k: "Ctrl+C", label: "again to exit (progress saved)", color: theme.red }
        : { k: "^C ^C", label: "exit", color: theme.red };

    if (state.countdown != null) {
        drawHints(g, H - 1, [{ k: "enter", label: "continue now", color: theme.sky }], [exitHint]);
        drawCountdownModal(g, state);
        if (state.helpOpen) drawHelpModal(g, state);
        return;
    }
    if (promptActive) {
        // The modal carries its own key line; the nav hints would contradict it.
        drawHints(g, H - 1, [], [exitHint]);
        drawPromptModal(g, state);
        if (state.helpOpen) drawHelpModal(g, state);
        return;
    }
    drawHints(
        g,
        H - 2,
        [
            { k: "↑↓ / j k", label: "scroll document" },
            { k: "f", label: "follow latest" },
            { k: "g / G", label: "top / bottom" },
        ],
        [
            { k: "?", label: "help", color: theme.sky },
            { k: "enter", label: "open selected", color: theme.sky },
        ],
    );
    const focusHints: Hint[] = [{ k: "←→ / h l", label: "files / document", color: theme.sky }];
    if (state.nav.focus === "main") focusHints.push({ k: "esc", label: "back to files", color: theme.sky });
    drawHints(g, H - 1, focusHints, [exitHint]);

    if (state.helpOpen) drawHelpModal(g, state);
}
