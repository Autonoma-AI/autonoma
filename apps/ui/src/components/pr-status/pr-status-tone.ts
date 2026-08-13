import type { CheckpointTone } from "@autonoma/types";

/**
 * How much weight a status is given.
 *
 * `verdict` is a page's headline - the one thing on screen, and the reason the page was opened. Every tone is
 * filled there, because nothing is competing with it.
 *
 * `row` is one line among twenty-five. Filling every tone in a list turns the column into a wall of colour in
 * which nothing stands out - and the states that would be coloured most often (passing, building, pending
 * checks) are exactly the ones that need nothing from the reader. So in a row, **a filled box means act on
 * this**, and only `critical` earns one. `warning` keeps its colour and loses the fill; the settled and
 * in-flight states become quiet text with a coloured dot, which still tells them apart at a glance.
 *
 * The words do not change between the two - only how loudly they are said - so a pull request still reads the
 * same wherever you meet it.
 */
export type PrStatusWeight = "verdict" | "row";

const VERDICT_CLASS: Record<CheckpointTone, string> = {
    critical: "border-status-critical bg-status-critical/10 text-status-critical",
    warning: "border-status-warn bg-status-warn/10 text-status-warn",
    success: "border-status-success bg-status-success/10 text-status-success",
    neutral: "border-status-pending/30 bg-status-pending/10 text-status-pending",
};

const ROW_CLASS: Record<CheckpointTone, string> = {
    critical: VERDICT_CLASS.critical,
    warning: "border-transparent text-status-warn",
    success: "border-transparent text-text-secondary",
    neutral: "border-transparent text-text-secondary",
};

const DOT_CLASS: Record<CheckpointTone, string> = {
    critical: "bg-status-critical",
    warning: "bg-status-warn",
    success: "bg-status-success",
    neutral: "bg-text-secondary",
};

export interface PrStatusToneClasses {
    pill: string;
    /** Set only when the pill carries no fill of its own, so the tone still reads. */
    dot?: string;
}

export function prStatusToneClasses(tone: CheckpointTone, weight: PrStatusWeight): PrStatusToneClasses {
    if (weight === "verdict") return { pill: VERDICT_CLASS[tone] };
    if (tone === "critical") return { pill: ROW_CLASS.critical };
    return { pill: ROW_CLASS[tone], dot: DOT_CLASS[tone] };
}
