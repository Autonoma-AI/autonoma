/**
 * The slash command a developer comments on a PR to request an analysis run under activation.
 */
export const MERGE_GATE_START_COMMAND = "/start analysis";

/**
 * True when the PR comment body is the `/start analysis` command.
 */
export function isStartAnalysisCommand(commentBody: string): boolean {
    return commentBody.trim() === MERGE_GATE_START_COMMAND;
}
