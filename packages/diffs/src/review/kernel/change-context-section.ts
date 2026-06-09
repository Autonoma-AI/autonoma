import type { ChangeContext } from "./widened-context";

/**
 * Renders the DB-sourced change facts the loader gathered, plus the explicit
 * instruction to inspect the actual diff via `git diff` in bash. The raw
 * changed-file list and hunks are deliberately not embedded - the reviewer
 * pulls them from the checked-out tree itself so the prompt stays small and
 * the agent grounds its attribution in the real diff.
 *
 * `intro` is the subject-specific lead-in sentence (it names the subject - a
 * replay vs a generation - and the verdict choice the diff informs), letting
 * both reviewers share the identical diff-facts body below it.
 */
export function buildChangeContextSection(change: ChangeContext, intro: string): string {
    const lines = [
        intro,
        "",
        "```bash",
        `git diff ${change.baseSha}..${change.headSha}`,
        "```",
        "",
        `- **Base SHA** (before the change): \`${change.baseSha}\``,
        `- **Head SHA** (under test): \`${change.headSha}\``,
    ];

    if (change.analysisReasoning != null) {
        lines.push("", "### Change Analysis", change.analysisReasoning);
    }

    if (change.affectedReason != null || change.affectedReasoning != null) {
        lines.push("", "### Why This Test Was Flagged");
        if (change.affectedReason != null) {
            lines.push(`- **Affected reason**: \`${change.affectedReason}\``);
        }
        if (change.affectedReasoning != null) {
            lines.push(change.affectedReasoning);
        }
    }

    return lines.join("\n");
}
