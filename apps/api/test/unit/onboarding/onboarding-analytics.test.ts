import { PostHogAnalytics } from "@autonoma/analytics";
import type { OnboardingPreviewEnvironmentMode, OnboardingStep } from "@autonoma/db";
import { describe, expect, it } from "vitest";
import { OnboardingAnalytics, type OnboardingStateReader } from "../../../src/routes/onboarding/onboarding-analytics";

interface CapturedEvent {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    groups?: Record<string, string>;
}

/** Records every `capture(...)` instead of shipping it, so we can assert the emitted event. */
class RecordingAnalytics extends PostHogAnalytics {
    public captures: CapturedEvent[] = [];

    override capture(
        distinctId: string,
        event: string,
        properties?: Record<string, unknown>,
        groups?: Record<string, string>,
    ): void {
        this.captures.push({ distinctId, event, properties, groups });
    }
}

const ACTOR = { distinctId: "user-1", organizationId: "org-7", applicationId: "app-1" };
/** No acting user: the customer's CI, or Autonoma observing its own deploy go ready. */
const MACHINE_ACTOR = { distinctId: "org-7", organizationId: "org-7", applicationId: "app-1" };
const STARTED_AT = new Date("2026-08-05T10:00:00.000Z");

/**
 * Hands back a different step on each read, so one call can be observed moving
 * the onboarding along. A single step repeats it for every read, which is the
 * "nothing moved" case.
 */
function stateReader(
    steps: OnboardingStep[],
    previewEnvironmentMode: OnboardingPreviewEnvironmentMode | null = null,
): OnboardingStateReader {
    const remaining = [...steps];
    return {
        onboardingState: {
            findUnique: async () => {
                const step = remaining.length > 1 ? remaining.shift() : remaining[0];
                if (step == null) return null;
                return { step, previewEnvironmentMode, createdAt: STARTED_AT };
            },
        },
    };
}

/** A reader for an application that has no onboarding row at all. */
const noStateReader: OnboardingStateReader = {
    onboardingState: { findUnique: async () => null },
};

function eventsNamed(analytics: RecordingAnalytics, event: string): CapturedEvent[] {
    return analytics.captures.filter((captured) => captured.event === event);
}

describe("onboarding.procedure_called", () => {
    it("records the step the user acted FROM, attributed to the user and their org", async () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(
            stateReader(["existing_deploys_configuring", "preview_verified"]),
            posthog,
        );

        await analytics.trackMutation(ACTOR, "onboarding.selectVercelDeployment", async () => ({ ok: true }) as const);

        const [captured] = eventsNamed(posthog, "onboarding.procedure_called");
        expect(captured?.distinctId).toBe("user-1");
        expect(captured?.groups).toEqual({ organization: "org-7" });
        expect(captured?.properties).toMatchObject({
            procedure: "onboarding.selectVercelDeployment",
            success: true,
            applicationId: "app-1",
            organizationId: "org-7",
            // The step they were on when they clicked, NOT the one they landed on.
            step: "existing_deploys_configuring",
        });
        expect(captured?.properties?.durationMs).toBeTypeOf("number");
    });

    it("carries the failure reason when tRPC hands the failure back as a result", async () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(stateReader(["existing_deploys_configuring"]), posthog);

        await analytics.trackMutation(ACTOR, "onboarding.linkVercelProject", async () => ({
            ok: false as const,
            error: new Error("Vercel project is already linked to application app-9"),
        }));

        const [captured] = eventsNamed(posthog, "onboarding.procedure_called");
        expect(captured?.properties).toMatchObject({
            success: false,
            errorName: "Error",
            errorMessage: "Vercel project is already linked to application app-9",
        });
    });

    it("records the failure and rethrows when the mutation throws", async () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(stateReader(["github"]), posthog);

        await expect(
            analytics.trackMutation(ACTOR, "onboarding.completeGithub", async () => {
                throw new Error("kaboom");
            }),
        ).rejects.toThrow("kaboom");

        expect(eventsNamed(posthog, "onboarding.procedure_called")[0]?.properties).toMatchObject({
            success: false,
            errorName: "Error",
            errorMessage: "kaboom",
        });
    });

    it("truncates a long failure message rather than shipping a stack-sized property", async () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(stateReader(["github"]), posthog);

        await analytics.trackMutation(ACTOR, "onboarding.completeGithub", async () => ({
            ok: false as const,
            error: new Error("x".repeat(5_000)),
        }));

        const message = eventsNamed(posthog, "onboarding.procedure_called")[0]?.properties?.errorMessage;
        expect(typeof message === "string" && message.length < 1_000).toBe(true);
    });
});

describe("onboarding.step_changed", () => {
    it("reports the transition a mutation caused, with what caused it", async () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(
            stateReader(["existing_deploys_configuring", "preview_verified"], "existing_deploys"),
            posthog,
        );

        await analytics.trackMutation(ACTOR, "onboarding.selectVercelDeployment", async () => ({ ok: true }) as const);

        const [captured] = eventsNamed(posthog, "onboarding.step_changed");
        expect(captured?.properties).toMatchObject({
            fromStep: "existing_deploys_configuring",
            toStep: "preview_verified",
            previewEnvironmentMode: "existing_deploys",
            action: "onboarding.selectVercelDeployment",
            surface: "ui",
        });
        expect(captured?.properties?.secondsSinceStarted).toBeTypeOf("number");
    });

    it("is not emitted when the step did not move, so retries do not inflate the funnel", async () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(stateReader(["existing_deploys_configuring"]), posthog);

        await analytics.trackMutation(ACTOR, "onboarding.linkVercelProject", async () => ({ ok: true }) as const);

        expect(eventsNamed(posthog, "onboarding.step_changed")).toHaveLength(0);
        expect(eventsNamed(posthog, "onboarding.procedure_called")).toHaveLength(1);
    });

    it("counts preview_verified reached by the customer's CI, which no tracker wraps", async () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(stateReader(["preview_verified"], "existing_deploys"), posthog);

        // `fromStep` comes from writePreviewUrl's own result, so the "did it
        // advance?" condition has one definition rather than a copy here.
        await analytics.stepAdvanced(MACHINE_ACTOR, "deployment_signal", "signal", "existing_deploys_waiting");

        const [captured] = eventsNamed(posthog, "onboarding.step_changed");
        expect(captured?.distinctId).toBe("org-7");
        expect(captured?.properties).toMatchObject({
            fromStep: "existing_deploys_waiting",
            toStep: "preview_verified",
            action: "deployment_signal",
            surface: "signal",
        });
    });

    it("counts preview_verified reached by the PreviewKit readiness poll", async () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(stateReader(["preview_verified"], "previewkit"), posthog);

        await analytics.stepAdvanced(MACHINE_ACTOR, "previewkit_deploy_ready", "system", "previewkit_deploying");

        expect(eventsNamed(posthog, "onboarding.step_changed")[0]?.properties).toMatchObject({
            fromStep: "previewkit_deploying",
            toStep: "preview_verified",
            surface: "system",
        });
    });

    it("claims no advance when the step was already where the caller thought it moved from", async () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(stateReader(["preview_verified"]), posthog);

        await analytics.stepAdvanced(MACHINE_ACTOR, "deployment_signal", "signal", "preview_verified");

        expect(eventsNamed(posthog, "onboarding.step_changed")).toHaveLength(0);
    });

    it("tags an agent-driven transition as such, and emits only the transition", async () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(
            stateReader(["existing_deploys_configuring", "preview_verified"]),
            posthog,
        );

        await analytics.trackAgentWrite(ACTOR, "select_vercel_deployment", async () => undefined);

        // `mcp.tool_called` already covers the call itself; a second per-call event here would double-count.
        expect(eventsNamed(posthog, "onboarding.procedure_called")).toHaveLength(0);
        expect(eventsNamed(posthog, "onboarding.step_changed")[0]?.properties).toMatchObject({
            fromStep: "existing_deploys_configuring",
            toStep: "preview_verified",
            action: "select_vercel_deployment",
            surface: "agent",
        });
    });
});

describe("an application with no onboarding row yet", () => {
    it("still records the action, and claims no transition it cannot see", async () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(noStateReader, posthog);

        await analytics.trackMutation(ACTOR, "onboarding.completeGithub", async () => ({ ok: true }) as const);

        expect(eventsNamed(posthog, "onboarding.procedure_called")[0]?.properties).toMatchObject({ success: true });
        expect(eventsNamed(posthog, "onboarding.step_changed")).toHaveLength(0);
    });
});

describe("onboarding.dry_run_passed", () => {
    it("attributes the pass to the acting user, so the funnel can answer who finished setting up", () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(noStateReader, posthog);

        analytics.dryRunPassed(ACTOR, "scenario-3");

        const [captured] = eventsNamed(posthog, "onboarding.dry_run_passed");
        expect(captured?.distinctId).toBe("user-1");
        expect(captured?.groups).toEqual({ organization: "org-7" });
        expect(captured?.properties).toMatchObject({ applicationId: "app-1", scenarioId: "scenario-3" });
    });

    it("carries no error field, so a customer's endpoint text can never ride along", () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(noStateReader, posthog);

        analytics.dryRunPassed(ACTOR, "scenario-3");

        const [captured] = eventsNamed(posthog, "onboarding.dry_run_passed");
        expect(Object.keys(captured?.properties ?? {}).sort()).toEqual([
            "applicationId",
            "organizationId",
            "scenarioId",
        ]);
    });
});

describe("onboarding.deployment_signal_received", () => {
    it("is attributed to the organization, since the customer's CI has no user", () => {
        const posthog = new RecordingAnalytics();
        const analytics = new OnboardingAnalytics(noStateReader, posthog);

        analytics.deploymentSignalReceived({
            organizationId: "org-7",
            applicationId: "app-1",
            outcome: "preview_recorded",
            stepBefore: "existing_deploys_waiting",
            previewEnvironmentMode: "existing_deploys",
        });

        const [captured] = eventsNamed(posthog, "onboarding.deployment_signal_received");
        expect(captured?.distinctId).toBe("org-7");
        expect(captured?.groups).toEqual({ organization: "org-7" });
        expect(captured?.properties).toMatchObject({
            applicationId: "app-1",
            outcome: "preview_recorded",
            stepBefore: "existing_deploys_waiting",
        });
    });
});
