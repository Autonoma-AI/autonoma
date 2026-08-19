import type { Grid } from "../grid";
import { theme } from "../theme";
import type { RunState } from "../types";
import { MIN_COLUMNS, MIN_ROWS, terminalRowsFor } from "../viewport";
import { wrapPlain } from "./wrap";

const BRAND = "◆ autonoma";
/** Left margin; the notice has no border, so it starts one cell in. */
const X0 = 1;

interface Line {
    text: string;
    color: string;
    bold?: boolean;
}

/**
 * What to show instead of the dashboard when the window is smaller than it can
 * be drawn in (see `gridFitsDashboard`).
 *
 * This is an instruction, not an error: nothing has gone wrong, the window is
 * simply too small to lay a dashboard out in, and one drag fixes it. It keeps
 * the brand line and the calm palette the rest of the UI uses, and says what to
 * do first - a screen that reads as a crash sends people to the docs (or to
 * support) instead of to the corner of their terminal.
 *
 * Deliberately plain - no box, no centring, no columns: every one of those is a
 * thing that breaks at the sizes this screen exists to handle. Lines are
 * ordered most useful first and simply clipped at the bottom edge, so the
 * instruction survives even in a three-row window.
 */
export function drawResizeNotice(g: Grid, state: RunState): void {
    const columns = g.w;
    const rows = terminalRowsFor(g.h);
    const maxW = Math.max(1, columns - X0 * 2);
    const body = wrapAll(noticeLines(state, columns, rows), maxW);
    // The brand line is what makes this read as the product talking rather than
    // a stack trace, so it goes in whenever the rows can be spared.
    const branded = g.h >= body.length + 3 ? [{ text: BRAND, color: theme.accent, bold: true }, BLANK, ...body] : body;

    // Top margin only when there is room to spare for it.
    let y = g.h > branded.length + 2 ? 1 : 0;
    for (const line of branded) {
        g.text(X0, y, line.text, { color: line.color, bold: line.bold });
        y++;
    }

    // The run is still interruptible, and Ctrl+C is the only key that does
    // anything while this is up - everything else is swallowed, since acting on
    // a UI nobody can read is worse than ignoring the press.
    if (g.h > branded.length + 1) {
        g.text(X0, g.h - 1, "^C ^C", { color: theme.red, bold: true });
        g.text(X0 + 6, g.h - 1, "exit", { color: theme.secondary });
    }
}

const BLANK: Line = { text: "", color: theme.text };

function noticeLines(state: RunState, columns: number, rows: number): Line[] {
    const lines: Line[] = [
        { text: "Expand this window to see the dashboard", color: theme.text, bold: true },
        BLANK,
        {
            text: `${dragVerb(columns, rows)} - the dashboard needs ${MIN_COLUMNS}x${MIN_ROWS}, and this window is ${columns}x${rows}.`,
            color: theme.secondary,
        },
        BLANK,
        { text: "Your run carries on in the background.", color: theme.secondary },
    ];

    if (isWaitingOnUser(state)) {
        lines.push({ text: "A question is waiting for you on the dashboard.", color: theme.accent });
    }
    return lines;
}

/** Name the axis that is actually short, so the fix is one drag. */
function dragVerb(columns: number, rows: number): string {
    const narrow = columns < MIN_COLUMNS;
    const short = rows < MIN_ROWS;
    if (narrow && short) return "Drag it bigger";
    if (narrow) return "Drag it wider";
    return "Drag it taller";
}

/** Every mode where the pipeline is blocked until the user presses a key. */
function isWaitingOnUser(state: RunState): boolean {
    return state.prompt.current != null || state.welcome != null || state.completion != null;
}

function wrapAll(lines: Line[], maxW: number): Line[] {
    return lines.flatMap((line) => {
        if (line.text === "") return [line];
        return wrapPlain(line.text, maxW).map((text) => ({ text, color: line.color, bold: line.bold }));
    });
}
