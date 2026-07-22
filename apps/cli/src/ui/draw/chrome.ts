import type { StyledLine } from "../components/render-content";
import { computeEta, formatClock, formatEtaLabel } from "../eta";
import type { Grid, Style } from "../grid";
import { theme } from "../theme";
import type { RunState } from "../types";

const BRAND = "◆ autonoma";

/** Draw pre-styled spans (from renderContent) into the grid, truncated to maxW. */
export function drawSpans(g: Grid, x: number, y: number, spans: StyledLine, maxW: number): void {
    let cx = x;
    for (const s of spans) {
        for (const ch of s.text) {
            if (cx >= x + maxW) return;
            const st: Style = { color: s.dim ? theme.tertiary : s.color, bold: s.bold };
            g.set(cx, y, ch, st);
            cx++;
        }
    }
}

/** Top bar: brand + title, right metrics, subtitle, progress underline (rows 0-2). */
export function drawTopBar(g: Grid, state: RunState): void {
    const W = g.w;
    const eta = computeEta(state);
    const { meta } = state;
    const elapsed = formatClock(eta.elapsedMs);
    const outcome = state.finished ? (state.outcome?.kind ?? "complete") : undefined;
    const etaText = outcome === "failed" ? "stopped" : outcome === "paused" ? "paused" : formatEtaLabel(eta);
    const etaColor =
        outcome === "failed"
            ? theme.red
            : outcome === "paused"
              ? theme.amber
              : eta.complete
                ? theme.green
                : theme.accent;
    const pct = Math.round(eta.pct);

    g.text(0, 0, BRAND, { color: theme.accent, bold: true });
    g.text(BRAND.length + 1, 0, "│", { color: theme.cardEdge });
    g.text(BRAND.length + 3, 0, meta.title, { color: theme.text, bold: true });

    // right metrics, right-aligned
    const segs: { t: string; st: Style }[] = [
        { t: "ELAPSED ", st: { color: theme.tertiary } },
        { t: elapsed, st: { color: theme.text, bold: true } },
        { t: "   ETA ", st: { color: theme.tertiary } },
        { t: etaText, st: { color: etaColor, bold: true } },
        { t: "   ", st: {} },
        { t: `${pct}%`, st: { color: theme.accent, bold: true } },
    ];
    const total = segs.reduce((n, s) => n + s.t.length, 0);
    let x = W - total;
    for (const s of segs) {
        g.text(x, 0, s.t, s.st);
        x += s.t.length;
    }

    // subtitle
    const sub = [meta.project, `planner v${meta.version}`].join("  ·  ");
    g.text(0, 1, sub, { color: theme.tertiary });
    if (meta.stepNote != null) g.text(sub.length + 3, 1, meta.stepNote, { color: theme.amber });

    // progress underline
    const filled = Math.max(0, Math.min(W, Math.round((W * pct) / 100)));
    g.hline(0, 2, filled, "━", theme.accent);
    g.hline(filled, 2, W - filled, "━", theme.faint);
}

/** A full-width controls line at row y: left hints + right hints. */
export interface Hint {
    k: string;
    label: string;
    color?: string;
}

export function drawHints(g: Grid, y: number, left: Hint[], right: Hint[]): void {
    let x = 0;
    for (let i = 0; i < left.length; i++) {
        if (i > 0) x += 3;
        const h = left[i]!;
        g.text(x, y, h.k, { color: h.color ?? theme.accent, bold: true });
        x += h.k.length;
        g.text(x, y, " " + h.label, { color: theme.secondary });
        x += h.label.length + 1;
    }
    // right group, right-aligned
    const rlen = right.reduce((n, h) => n + h.k.length + 1 + h.label.length, 0) + (right.length - 1) * 3;
    let rx = g.w - rlen;
    for (let i = 0; i < right.length; i++) {
        if (i > 0) rx += 3;
        const h = right[i]!;
        g.text(rx, y, h.k, { color: h.color ?? theme.accent, bold: true });
        rx += h.k.length;
        g.text(rx, y, " " + h.label, { color: theme.secondary });
        rx += h.label.length + 1;
    }
}
