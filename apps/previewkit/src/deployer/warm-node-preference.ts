import type * as k8s from "@kubernetes/client-node";

// Must match the node label the `warm` NodePool stamps on its node
// (deployment/previewkit/cluster/karpenter/nodepool-warm.yaml).
const WARM_NODE_LABEL_KEY = "previewkit.dev/node-role";
const WARM_NODE_LABEL_VALUE = "warm";

/**
 * Scheduling preference for the warm node - the one static on-demand node
 * whose containerd cache holds recently pulled preview images. Landing there
 * lets a Gatekeeper wake skip node provisioning and the image pull, the two
 * slowest wake stages.
 *
 * Preferred, never required: when the warm node is full or absent, pods fall
 * back to the spot pool exactly as before.
 */
export function warmNodeAffinity(): k8s.V1Affinity {
    return {
        nodeAffinity: {
            preferredDuringSchedulingIgnoredDuringExecution: [
                {
                    weight: 100,
                    preference: {
                        matchExpressions: [
                            {
                                key: WARM_NODE_LABEL_KEY,
                                operator: "In",
                                values: [WARM_NODE_LABEL_VALUE],
                            },
                        ],
                    },
                },
            ],
        },
    };
}
