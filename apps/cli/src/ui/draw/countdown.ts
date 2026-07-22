import type { Grid } from "../grid";
import { theme } from "../theme";
import type { RunState } from "../types";
import { wrapPlain } from "./wrap";

const MODAL_MAX_W = 96;
const MODAL_FILL = "#141414";

/**
 * The pre-handoff countdown: a centered modal explaining what is about to
 * happen to the terminal, with the seconds remaining until it happens. Enter
 * continues immediately; the store dismisses it automatically at zero.
 */
export function drawCountdownModal(g: Grid, state: RunState): void {
    const c = state.countdown;
    if (c == null) return;
    const W = g.w;
    const H = g.h;

    const w = Math.min(MODAL_MAX_W, W - 6);
    const innerW = w - 6;

    const titleLines = wrapPlain(c.title, innerW);
    const bodyLines = c.lines.flatMap((line, i) => {
        const wrapped = wrapPlain(line, innerW);
        return i === 0 ? wrapped : ["", ...wrapped];
    });

    const h = 2 + 1 + titleLines.length + 1 + bodyLines.length + 2 + 2;
    const x = Math.floor((W - w) / 2);
    const y = Math.max(2, Math.floor((H - h) / 2));

    // Blank the area, border it, and re-tint so the border sits on the fill.
    g.clearRect(x, y, w, h, MODAL_FILL);
    g.rect(x, y, w, h, { edge: theme.cardEdge, corner: theme.accent });
    for (let yy = y; yy < y + h; yy++) g.fillBg(x, yy, w, MODAL_FILL);
    const bg = MODAL_FILL;

    let cy = y + 1;
    g.text(x + 3, cy, " UP NEXT ", { bg: theme.accent, color: theme.onAccent, bold: true });
    cy += 2;

    for (const line of titleLines) {
        g.text(x + 3, cy, line, { color: theme.text, bold: true, bg });
        cy++;
    }
    cy++;
    for (const line of bodyLines) {
        g.text(x + 3, cy, line, { color: theme.secondary, bg });
        cy++;
    }

    const remaining = Math.max(0, Math.ceil((c.endsAt - state.now) / 1000));
    const label = `Continuing in ${remaining}s`;
    const ly = y + h - 2;
    g.text(x + 3, ly, label, { color: theme.accent, bold: true, bg });
    g.text(x + 3 + label.length + 3, ly, "enter", { color: theme.accent, bold: true, bg });
    g.text(x + 3 + label.length + 3 + 6, ly, "continue now", { color: theme.secondary, bg });
}
