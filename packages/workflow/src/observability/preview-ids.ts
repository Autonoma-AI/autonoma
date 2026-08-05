import type { ObservabilityContext } from "@autonoma/logger";
import type { PreviewDeployTarget } from "@autonoma/types";

/** The canonical groups a preview names: the org it belongs to and the repo + ref its build is for. */
export function previewIds(target: PreviewDeployTarget): ObservabilityContext {
    return {
        organization: { organizationId: target.organizationId },
        preview: { repo: target.repoFullName, headRef: target.headRef },
    };
}
