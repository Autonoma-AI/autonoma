import type { ChangeContext } from "./widened-context";

const INTRO =
    "This generation executed against the head commit of a code change. To attribute the failure between `plan_mismatch`, `application_bug`, and `agent_limitation`, inspect what actually changed by running this in the bash tool:";

/**
 * Renders the DB-sourced change facts the loader gathered, plus the explicit
 * instruction to inspect the actual diff via `git diff` in bash. The raw
 * changed-file list and hunks are deliberately not embedded - the reviewer
 * pulls them from the checked-out tree itself so the prompt stays small and
 * the agent grounds its attribution in the real diff.
 */
export function buildChangeContextSection(change: ChangeContext): string {
    const lines = [
        INTRO,
        "",
        "```bash",
        `git diff ${change.baseSha}..${change.headSha}`,
        "```",
        "",
        `- **Base SHA** (before the change): \`${change.baseSha}\``,
        `- **Head SHA** (under test): \`${change.headSha}\``,
    ];

    return lines.join("\n");
}
