import { TemplateInput, argoTemplates } from "../../k8s/argo";
import { imageContainer } from "../../k8s/container";

const INPUTS = { runId: new TemplateInput("run-id") };

export async function runNotificationTemplate() {
    const container = await imageContainer({
        name: "notify-run-exit",
        imageKey: "run-completion-notification",
        secretFile: "run-completion-notification-file",
        command: ["node", "dist/index.js"],
        args: ["run-exit", `${INPUTS.runId}`],
        resources: {
            requests: { cpu: "50m", memory: "64Mi" },
            limits: { cpu: "250m", memory: "256Mi" },
        },
    });

    return argoTemplates.container({
        name: "notify-run-exit",
        inputs: INPUTS,
        outputs: {},
        container,
        retryStrategy: {
            limit: 2,
        },
    });
}
