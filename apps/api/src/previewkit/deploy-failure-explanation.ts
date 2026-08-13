import { fatalReasonFromMessage, type FatalWaitingReason } from "@autonoma/k8s/preview-liveness";
import type { DeployFailureExplanation, DeployFailureEvidenceSource } from "@autonoma/types";

/**
 * A rollout that timed out without any pod reaching a named terminal reason. The deployer
 * raises this wording itself (`deployer.ts`), so it is matched as a phrase rather than as a
 * Kubernetes reason.
 */
const ROLLOUT_TIMEOUT_PATTERN = /will not become ready/i;

/**
 * The user-facing explanation for each terminal pod reason.
 *
 * Keyed by {@link FatalWaitingReason} rather than by a hand-written list, so a reason added to
 * the k8s package is a compile error here instead of silently falling through to the generic
 * wording. `lookIn` is the load-bearing field: it is what stops a crashloop being explained
 * with "check the build logs", which is where a reader was sent before any of this existed and
 * is the one place the answer is guaranteed not to be.
 */
const REASON_EXPLANATIONS: Record<FatalWaitingReason, Omit<DeployFailureExplanation, "technicalDetail">> = {
    CrashLoopBackOff: {
        title: "The app started and then exited",
        explanation:
            "The image built and the container ran, but the process stopped almost immediately and Kubernetes " +
            "has been restarting it in a loop. Something the app needs at startup is missing or wrong - a " +
            "database it cannot reach, an environment variable it reads on boot, a migration that has not run.",
        lookIn: "app_logs",
    },
    ImagePullBackOff: {
        title: "The image could not be pulled",
        explanation:
            "The deployment was accepted but the preview cluster could not fetch the app's image. The build " +
            "usually did not publish it.",
        lookIn: "build_logs",
    },
    ErrImagePull: {
        title: "The image could not be pulled",
        explanation:
            "The preview cluster could not fetch the app's image on its first attempt. The build usually did " +
            "not publish it.",
        lookIn: "build_logs",
    },
    ErrImageNeverPull: {
        title: "The image was never pulled",
        explanation:
            "The container is configured never to pull, and the image is not present on the node. This is a " +
            "platform-side misconfiguration rather than anything in your repository.",
        lookIn: "build_logs",
    },
    InvalidImageName: {
        title: "The image name is not valid",
        explanation:
            "Kubernetes rejected the image reference before pulling anything. The tag the build produced is " +
            "malformed.",
        lookIn: "build_logs",
    },
    CreateContainerConfigError: {
        title: "The container could not be configured",
        explanation:
            "Kubernetes could not assemble the container's configuration, which almost always means an " +
            "environment variable references a secret that does not exist. Nothing ran, so there are no " +
            "application logs to read.",
        lookIn: "config",
    },
    CreateContainerError: {
        title: "The container could not be created",
        explanation:
            "The runtime refused to create the container. This is usually the entrypoint or command: a path " +
            "that does not exist in the image, or a file that is not executable.",
        lookIn: "config",
    },
    RunContainerError: {
        title: "The container could not be started",
        explanation:
            "The container was created but the runtime could not run its command. This is usually the " +
            "entrypoint: a binary that is missing from the image, or a script without a shebang.",
        lookIn: "config",
    },
};

const ROLLOUT_TIMEOUT_EXPLANATION: Omit<DeployFailureExplanation, "technicalDetail"> = {
    title: "The app never became ready",
    explanation:
        "The container is running but never reported itself healthy, so the rollout gave up waiting. Either it " +
        "is still starting when the deadline passes, or it is not listening on the port the config declares.",
    lookIn: "app_logs",
};

/**
 * Turns a raw deploy error into something a reader can act on, keeping the original text.
 *
 * These messages reach the UI verbatim today, which is how somebody debugging their first
 * preview is shown a pod hash, a namespace UUID and the word "CrashLoopBackOff". The same
 * translation already existed for the coding agent that reads `diagnose_deploy`; this is what
 * lets the person on the screen have it too.
 *
 * This module is only the copy. Which reasons exist, and how to find one in a message, belong to
 * `@autonoma/k8s/preview-liveness` alongside the structural extractor that reads them off a live
 * pod - so a reason cannot be recognised in one place and unknown in the other.
 *
 * Returns undefined when the text matches nothing known, so callers keep showing the raw error
 * rather than inventing a confident explanation for a message nobody has classified.
 */
export function explainDeployFailure(rawError: string | undefined): DeployFailureExplanation | undefined {
    if (rawError == null || rawError.trim() === "") return undefined;

    const reason = fatalReasonFromMessage(rawError);
    if (reason != null) {
        return { ...REASON_EXPLANATIONS[reason], technicalDetail: rawError };
    }

    if (ROLLOUT_TIMEOUT_PATTERN.test(rawError)) {
        return { ...ROLLOUT_TIMEOUT_EXPLANATION, technicalDetail: rawError };
    }

    return undefined;
}

/** Where a reader should go next, as a sentence. Shared by the UI and the agent's fix steps. */
export function describeEvidenceSource(lookIn: DeployFailureEvidenceSource): string {
    if (lookIn === "app_logs") return "Read the app's runtime logs - the App logs tab, not Build logs.";
    if (lookIn === "build_logs") return "Read the build logs for the step that failed to publish the image.";
    return "Check the app's configuration and secrets in the preview settings.";
}
