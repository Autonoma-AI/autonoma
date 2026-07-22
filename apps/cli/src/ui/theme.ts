/**
 * Design tokens for the TUI (see docs/ui-design-brief.md). The accent is
 * blacklight's brand lime, matching src/core/colors.ts. Hierarchy comes from
 * color tier + bold + background fills + spacing - never font size.
 */
export const theme = {
    /** Primary accent: active step, progress, primary action, brand. */
    accent: "#CCFF00",
    /** Body text. */
    text: "#EDEDED",
    /** The "why" lines, descriptions. */
    secondary: "#898989",
    /** Eyebrows, timestamps, dim labels. */
    tertiary: "#707070",
    /** Queued / inert. */
    faint: "#444444",

    sky: "#38BDF8", // WRITING / live / read calls
    violet: "#8B5CF6", // search / propose calls
    green: "#3FB950", // validation passed, success
    amber: "#FFB020", // paused / awaiting review
    orange: "#FF8800", // teardown / delete calls
    red: "#FF5C5C", // failures only

    /** Lime-tinted active-row / focus fill (solid approximation of rgba lime). */
    activeBg: "#1a2004",
    /** Neutral fill for the keyboard-selection cursor row. */
    selectionBg: "#2a2a2a",
    /** Black-on-lime text for primary buttons / pills. */
    onAccent: "#050505",

    border: "#333333", // panel hairlines
    borderChrome: "#454545", // chrome dividers (column separators)
    cardEdge: "#4a4a4a", // card border edges (corners use accent)
} as const;

/** Step status -> color for pipeline rendering. */
export const statusColor = {
    pending: theme.faint,
    running: theme.accent,
    done: theme.accent,
    failed: theme.red,
    paused: theme.amber,
} as const;
