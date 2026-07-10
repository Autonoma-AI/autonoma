// Terminal color palette mirrored from @autonoma/blacklight (packages/blacklight/src/index.css).
// blacklight's tokens are hex, so we render them with 24-bit truecolor ANSI escapes
// (`\x1b[38;2;R;G;Bm`) - every modern terminal supports it, and it lets the CLI match
// the product's exact brand color instead of the nearest 16-color approximation.

const ESC = "\x1b[";
export const RESET = `${ESC}0m`;
export const BOLD = `${ESC}1m`;
export const DIM = `${ESC}2m`;

function fg(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${ESC}38;2;${r};${g};${b}m`;
}

// --primary: #CCFF00 - blacklight's brand lime. This is the accent that carries
// the CLI's identity: banner, subagent lines, checkpoints.
export const PRIMARY = fg("#CCFF00");

// Status colors: kept distinct from the primary accent so success/error/warning
// still read semantically instead of collapsing into one lime tone.
export const SUCCESS = fg("#3FB950");
export const ERROR = fg("#FF5C5C");
export const WARNING = fg("#FFB020");
