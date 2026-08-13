import { FATAL_WAITING_REASON_NAMES } from "@autonoma/k8s/preview-liveness";
import { describe, expect, it } from "vitest";
import { explainDeployFailure } from "../../src/previewkit/deploy-failure-explanation";

/**
 * The exact shape the deployer produces and stores - `Deployment "<app>" will not become ready:
 * <terminal pod failure>` - with the pod hashes and namespace UUID a real message carries, since
 * the noise around the reason is the thing being translated away.
 *
 * Names are invented. This file syncs to the public mirror, so no customer's org or namespace
 * appears in it.
 */
const CRASHLOOP_MESSAGE =
    'Deployment "api" will not become ready: pod api-54d89594cc-nmjjn container api is in ' +
    "CrashLoopBackOff: back-off 10s restarting failed container=api " +
    "pod=api-54d89594cc-nmjjn_preview-acme-shop-pr-6(00000000-0000-4000-8000-000000000000)";

describe("explainDeployFailure", () => {
    it("sends a crashloop to the app logs, not the build logs", () => {
        const explanation = explainDeployFailure(CRASHLOOP_MESSAGE);

        expect(explanation?.title).toBe("The app started and then exited");
        // The whole point of the change: the generic wording used to say "review the build logs",
        // which is the one place a crashloop's cause is guaranteed not to be.
        expect(explanation?.lookIn).toBe("app_logs");
    });

    it("keeps the original message so nothing is lost behind the explanation", () => {
        expect(explainDeployFailure(CRASHLOOP_MESSAGE)?.technicalDetail).toBe(CRASHLOOP_MESSAGE);
    });

    it("sends an unpullable image to the build logs", () => {
        const explanation = explainDeployFailure(
            'Deployment "web" will not become ready: pod web-7c4 container web is in ImagePullBackOff',
        );

        expect(explanation?.lookIn).toBe("build_logs");
    });

    it("sends a missing secret to the config, where nothing ran to produce logs", () => {
        const explanation = explainDeployFailure(
            'Deployment "api" will not become ready: container api is in CreateContainerConfigError',
        );

        expect(explanation?.lookIn).toBe("config");
    });

    it("explains a rollout that timed out with no terminal pod reason", () => {
        const explanation = explainDeployFailure('Deployment "api" will not become ready: 0/1 replicas available');

        expect(explanation?.title).toBe("The app never became ready");
        expect(explanation?.lookIn).toBe("app_logs");
    });

    it("returns undefined for a message nothing classifies, so the raw text keeps being shown", () => {
        expect(explainDeployFailure("buildctl exited with code 1")).toBeUndefined();
    });

    it("returns undefined for absent or empty input", () => {
        expect(explainDeployFailure(undefined)).toBeUndefined();
        expect(explainDeployFailure("   ")).toBeUndefined();
    });

    it("recognises every reason the k8s package calls fatal", () => {
        // Pins the copy table to the vocabulary rather than to a hand-written list here: a reason
        // added to FATAL_WAITING_REASON_NAMES must gain an explanation, not silently fall through
        // to the generic rollout wording.
        for (const reason of FATAL_WAITING_REASON_NAMES) {
            const explanation = explainDeployFailure(
                `Deployment "api" will not become ready: container api is in ${reason}`,
            );

            expect(explanation, reason).toBeDefined();
            expect(explanation?.title, reason).not.toBe("The app never became ready");
        }
    });
});
