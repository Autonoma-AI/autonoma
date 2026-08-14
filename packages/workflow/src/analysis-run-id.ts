/**
 * The Temporal workflow id of a branch's analysis run. Keyed on the BRANCH - a branch holds at most one run in
 * flight - so the newest commit's run terminate-replaces the previous, and the proactive cancel on application
 * delete/unlink can address the run without knowing its snapshot. The single source of truth both the trigger and
 * the cancel derive the id from.
 */
export function analysisRunWorkflowId(branchId: string): string {
    return `analysis-run-${branchId}`;
}
