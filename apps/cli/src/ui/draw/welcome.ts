import type { Grid } from "../grid";
import { theme } from "../theme";
import type { RunState } from "../types";
import { wrapPlain } from "./wrap";

const MODAL_MAX_W = 84;
const MODAL_FILL = "#141414";

/**
 * The opening welcome: a big centered modal introducing Autonoma before the
 * pipeline starts. Waits for the user to press enter (the store dismisses it).
 */
export function drawWelcomeModal(g: Grid, state: RunState): void {
    const wel = state.welcome;
    if (wel == null) return;
    const W = g.w;
    const H = g.h;

    const w = Math.min(MODAL_MAX_W, W - 6);
    const innerW = w - 8;

    const titleLines = wrapPlain(wel.title, innerW);
    const bodyLines = wel.lines.flatMap((line, i) => {
        const wrapped = wrapPlain(line, innerW);
        return i === 0 ? wrapped : ["", ...wrapped];
    });

    const h = 2 + 1 + titleLines.length + 1 + bodyLines.length + 2 + 2;
    const x = Math.floor((W - w) / 2);
    const y = Math.max(2, Math.floor((H - h) / 2));

    g.clearRect(x, y, w, h, MODAL_FILL);
    g.rect(x, y, w, h, { edge: theme.cardEdge, corner: theme.accent });
    for (let yy = y; yy < y + h; yy++) g.fillBg(x, yy, w, MODAL_FILL);
    const bg = MODAL_FILL;

    let cy = y + 1;
    g.text(x + 4, cy, "◆ WELCOME TO AUTONOMA", { color: theme.accent, bold: true, bg });
    cy += 2;

    for (const line of titleLines) {
        g.text(x + 4, cy, line, { color: theme.text, bold: true, bg });
        cy++;
    }
    cy++;
    for (const line of bodyLines) {
        g.text(x + 4, cy, line, { color: theme.secondary, bg });
        cy++;
    }

    const ly = y + h - 2;
    g.text(x + 4, ly, wel.cta, { color: theme.accent, bold: true, bg });
}
