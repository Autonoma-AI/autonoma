import type { PreviewDeployTarget } from "@autonoma/types";

/**
 * Keyed on the COMMIT, not the (repo, PR) pair the Kubernetes Job mutex uses: a child workflow cannot terminate a
 * running same-id workflow, so two pushes contending for one id would race. Superseding stays with the launcher's
 * `previewkit.dev/env` label.
 */
export function previewBuildWorkflowId(target: PreviewDeployTarget): string {
    return `preview-build-${target.repoFullName}-${target.prNumber}-${target.headSha}`;
}
