import type { Grid } from "../grid";
import { theme } from "../theme";
import type { RunState } from "../types";
import { wrapPlain } from "./wrap";

const MODAL_MAX_W = 84;
const MODAL_FILL = "#141414";
const DEFAULT_EYEBROW = "WELCOME TO AUTONOMA";
/** Topmost row the modal may start on, leaving the progress bar visible above it. */
const MODAL_TOP = 2;
/** Border, eyebrow, blank, title, blank, blank, cta, border - everything but the body. */
const CHROME_ROWS = 8;

/**
 * A big centered modal that owns the screen until the user presses enter (the
 * store dismisses it). Introduces Autonoma before the pipeline starts, and
 * carries anything else the run cannot sensibly continue past unread.
 */
export function drawWelcomeModal(g: Grid, state: RunState): void {
    const wel = state.welcome;
    if (wel == null) return;
    const W = g.w;
    const H = g.h;

    const w = Math.min(MODAL_MAX_W, W - 6);
    const innerW = w - 8;

    const titleLines = wrapPlain(wel.title, innerW);

    // The body is author-written and unbounded, so it can outgrow a short
    // terminal - and drawing past the bottom edge silently loses instructions
    // the run cannot continue past. Give up the blank line between paragraphs
    // first (it buys a row per paragraph and costs only air), and only then
    // clamp, saying how much is missing.
    const chromeRows = CHROME_ROWS + titleLines.length;
    const bodyBudget = Math.max(1, H - MODAL_TOP - 1 - chromeRows);
    const paragraphs = wel.lines.map((line) => wrapPlain(line, innerW));
    const spaced = paragraphs.flatMap((lines, i) => (i === 0 ? lines : ["", ...lines]));
    const bodyLines = spaced.length <= bodyBudget ? spaced : paragraphs.flat();

    const overflows = bodyLines.length > bodyBudget;
    const shownBody = overflows ? bodyLines.slice(0, bodyBudget - 1) : bodyLines;
    const hiddenLines = bodyLines.length - shownBody.length;

    const h = chromeRows + shownBody.length + (overflows ? 1 : 0);
    const x = Math.floor((W - w) / 2);
    const y = Math.max(MODAL_TOP, Math.floor((H - h) / 2));

    g.clearRect(x, y, w, h, MODAL_FILL);
    g.rect(x, y, w, h, { edge: theme.cardEdge, corner: theme.accent });
    for (let yy = y; yy < y + h; yy++) g.fillBg(x, yy, w, MODAL_FILL);
    const bg = MODAL_FILL;

    let cy = y + 1;
    g.text(x + 4, cy, `◆ ${wel.eyebrow ?? DEFAULT_EYEBROW}`, { color: theme.accent, bold: true, bg });
    cy += 2;

    for (const line of titleLines) {
        g.text(x + 4, cy, line, { color: theme.text, bold: true, bg });
        cy++;
    }
    cy++;
    for (const line of shownBody) {
        g.text(x + 4, cy, line, { color: theme.secondary, bg });
        cy++;
    }
    if (overflows) {
        g.text(x + 4, cy, `+${hiddenLines} more lines - make the terminal taller to read them`, {
            color: theme.amber,
            bold: true,
            bg,
        });
    }

    const ly = y + h - 2;
    g.text(x + 4, ly, wel.cta, { color: theme.accent, bold: true, bg });
}
