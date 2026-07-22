// Minimum Node.js the planner supports. Not arbitrary: ink and react (our
// interactive UI) calls `util.styleText(["inverse", "hidden"], ...)`, and the
// array form of `styleText` only exists on Node >= 22.13 (and 23+). On older
// Node the first prompt render throws a cryptic `The argument 'format' must be
// one of: ...` error, so we fail fast here with an actionable message instead.
export const MIN_NODE = { major: 22, minor: 13 };

/**
 * Whether a `major.minor.patch` version string clears the minimum. Malformed
 * input (missing/non-numeric major or minor) is treated as unsupported so we
 * fail closed rather than let a prompt crash slip through.
 */
export function isSupportedNodeVersion(raw: string): boolean {
    const parts = raw.split(".");
    const major = Number.parseInt(parts[0] ?? "", 10);
    const minor = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
    return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

/**
 * Exit early with a clear message when the runtime is too old for the CLI's
 * dependencies. Uses plain `console` (not the TUI) on purpose: the TUI stack is exactly
 * what breaks on the unsupported versions, so it can't be trusted to render the
 * warning. Called as the very first thing the process does.
 */
export function ensureSupportedNode(): void {
    const raw = process.versions.node;
    if (isSupportedNodeVersion(raw)) return;

    console.error(
        `\x1b[31mAutonoma Planner requires Node.js >= ${MIN_NODE.major}.${MIN_NODE.minor} - you're running v${raw}.\x1b[0m`,
    );
    console.error("Please upgrade Node.js and re-run. See https://nodejs.org/en/download");
    process.exit(1);
}
