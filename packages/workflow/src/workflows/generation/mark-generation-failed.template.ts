import { TemplateInput, argoTemplates } from "../../k8s/argo";
import { imageContainer } from "../../k8s/container";

const INPUTS = { testGenerationId: new TemplateInput("test-generation-id") };

export async function markGenerationFailedTemplate() {
    const container = await imageContainer({
        name: "mark-generation-failed",
        imageKey: "run-completion-notification",
        secretFile: "run-completion-notification-file",
        command: ["node", "dist/index.js"],
        args: ["mark-failed", `${INPUTS.testGenerationId}`],
        resources: {
            requests: { cpu: "50m", memory: "64Mi" },
            limits: { cpu: "250m", memory: "256Mi" },
        },
    });

    return argoTemplates.container({
        name: "mark-generation-failed",
        inputs: INPUTS,
        outputs: {},
        container,
        retryStrategy: {
            limit: 2,
        },
    });
}
