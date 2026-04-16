import { env } from "./env";

export function getWorkflowSearchAttributes() {
    return {
        environment: [env.NAMESPACE],
    };
}
