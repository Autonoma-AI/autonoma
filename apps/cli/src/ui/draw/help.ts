import type { Grid } from "../grid";
import { STEP_DOCS, STEP_INTROS, STEP_SUMMARIES, UI_STEP_LABELS } from "../steps";
import { theme } from "../theme";
import type { RunState } from "../types";

const MODAL_MAX_W = 78;
const MODAL_FILL = "#141414";
/** How many recent warn/error lines the modal keeps reviewable. */
const RECENT_PROBLEMS = 4;

/** Word-wrap `text` to `maxW`, greedy. */
function wrap(text: string, maxW: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const word of words) {
        if (cur !== "" && (cur + " " + word).length > maxW) {
            lines.push(cur);
            cur = word;
        } else {
            cur = cur === "" ? word : `${cur} ${word}`;
        }
    }
    if (cur !== "") lines.push(cur);
    return lines;
}

/**
 * The "?" modal: what the current step is doing and why, where to read more,
 * and the key reference. Drawn over the dashboard as the last layer.
 */
export function drawHelpModal(g: Grid, state: RunState): void {
    const W = g.w;
    const H = g.h;
    const w = Math.min(MODAL_MAX_W, W - 8);
    const innerW = w - 6;

    const step = state.currentStep;
    const intro = step != null ? STEP_INTROS[step] : "The run has no active step right now.";
    const introLines = wrap(intro, innerW);
    const docsUrl = step != null ? STEP_DOCS[step] : undefined;

    // Body: intro + optional docs + pipeline list + keys block.
    const pipelineLines = state.stepOrder.length;
    const keys: [string, string][] = [
        ["←→ / h l", "switch between the file list and the document"],
        ["↑↓ / j k", "move the file cursor, or scroll the document"],
        ["enter / →", "open the selected file"],
        ["esc", "back to the file list"],
        ["f", "follow the newest file again"],
        ["g / G", "jump to top / bottom"],
        ["?", "toggle this help"],
        ["Ctrl+C twice", "exit - progress is saved, --resume continues"],
    ];

    // Errors scroll out of the activity feed; keep the recent ones reviewable.
    const problems = state.log.filter((e) => e.level === "error" || e.level === "warn").slice(-RECENT_PROBLEMS);

    const h =
        4 +
        introLines.length +
        (docsUrl != null ? 2 : 0) +
        2 +
        pipelineLines +
        2 +
        keys.length +
        (problems.length > 0 ? 2 + problems.length : 0) +
        2;
    const x = Math.floor((W - w) / 2);
    const y = Math.max(1, Math.floor((H - h) / 2));

    // Blank the whole area first - the dashboard is still painted underneath -
    // then draw the border and re-tint every row so the border sits on the
    // modal fill instead of punching holes to the terminal background.
    g.clearRect(x, y, w, h, MODAL_FILL);
    g.rect(x, y, w, h, { edge: theme.cardEdge, corner: theme.accent });
    for (let yy = y; yy < y + h; yy++) g.fillBg(x, yy, w, MODAL_FILL);
    const bg = MODAL_FILL;

    let cy = y + 1;
    const title = step != null ? `What's happening - ${UI_STEP_LABELS[step]}` : "What's happening";
    g.text(x + 3, cy, title, { color: theme.accent, bold: true, bg });
    cy += 2;

    for (const line of introLines) {
        g.text(x + 3, cy, line, { color: theme.text, bg });
        cy++;
    }
    if (docsUrl != null) {
        cy++;
        g.text(x + 3, cy, `read more  ${docsUrl}`, { color: theme.sky, bg });
        cy++;
    }

    cy++;
    g.text(x + 3, cy, "THE PIPELINE", { color: theme.tertiary, bg });
    cy++;
    state.stepOrder.forEach((name) => {
        const s = state.steps[name];
        const glyph = s.status === "done" ? "✓" : s.status === "running" ? "◐" : "○";
        const color = s.status === "done" || s.status === "running" ? theme.accent : theme.faint;
        g.text(x + 3, cy, glyph, { color, bg });
        g.text(x + 5, cy, UI_STEP_LABELS[name].padEnd(22), {
            color: s.status === "pending" ? theme.secondary : theme.text,
            bold: s.status === "running",
            bg,
        });
        g.text(x + 28, cy, STEP_SUMMARIES[name].slice(0, w - 31), { color: theme.tertiary, bg });
        cy++;
    });

    cy++;
    g.text(x + 3, cy, "KEYS", { color: theme.tertiary, bg });
    cy++;
    for (const [key, label] of keys) {
        g.text(x + 3, cy, key.padEnd(14), { color: theme.accent, bold: true, bg });
        g.text(x + 18, cy, label.slice(0, w - 21), { color: theme.secondary, bg });
        cy++;
    }

    if (problems.length > 0) {
        cy++;
        g.text(x + 3, cy, "RECENT PROBLEMS", { color: theme.tertiary, bg });
        cy++;
        for (const problem of problems) {
            const mark = problem.level === "error" ? "✗" : "!";
            const color = problem.level === "error" ? theme.red : theme.amber;
            g.text(x + 3, cy, mark, { color, bold: true, bg });
            g.text(x + 5, cy, problem.text.replace(/\s+/g, " ").slice(0, w - 8), { color: theme.secondary, bg });
            cy++;
        }
    }

    g.textRight(x + w - 3, y + h - 1, " ? or esc to close ", { color: theme.tertiary });
}
