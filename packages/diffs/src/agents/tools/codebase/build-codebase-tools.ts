import { BashTool } from "./bash-tool";

/**
 * The codebase-research tool set every diffs agent shares: a single read-only
 * {@link BashTool} that explores the cloned repo through the familiar shell
 * surface (`rg`, `sed -n`, `cat`, `find`, sequencing, pipes). The full contract
 * - allowed verbs, grammar, truncation - lives in the tool's own description, so
 * agents no longer enumerate per-tool guidance in their system prompts.
 *
 * Returns a fresh array each call; the tool itself is stateless (per-run state
 * arrives via the {@link CodebaseLoop}), so sharing a single instance would be
 * fine too - a new array just keeps each agent's tool list independent.
 */
export function buildCodebaseTools(): BashTool[] {
    return [new BashTool()];
}
