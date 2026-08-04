import { describe, expect, it } from "vitest";
import {
    describeAlreadyLive,
    describeUnfinishedStep,
    describeUnverifiedPreview,
    describeWentLive,
} from "../../../src/mcp/finish-onboarding-guidance";

describe("describeUnfinishedStep", () => {
    // The wall this closes: the state machine's own rejection is `Cannot go live
    // during "previewkit_configuring" step`, which names no call to make - so an
    // agent reads it as a transient failure and retries the same thing.
    it("names the step the app is on and the call that moves it forward", () => {
        const refusal = describeUnfinishedStep("previewkit_configuring", "idle");
        expect(refusal).toContain("previewkit_configuring");
        expect(refusal).toContain("trigger_deploy");
        expect(refusal).toContain("finish_onboarding again");
    });

    it("sends an app with no repository to the GitHub tools", () => {
        const refusal = describeUnfinishedStep("github", "idle");
        expect(refusal).toContain("get_github_connection");
        expect(refusal).toContain("link_repository");
    });

    it("sends an app that has not picked a path to select_preview_path", () => {
        expect(describeUnfinishedStep("preview_environment", "idle")).toContain("select_preview_path");
    });

    // A failed deploy never turns ready, so an agent told only "not ready yet"
    // polls forever instead of reading the logs it needs.
    it("ends the poll loop on a failed deploy and says where the cause is", () => {
        const refusal = describeUnfinishedStep("previewkit_deploying", "failed");
        expect(refusal).toContain("recentLogs");
        expect(refusal).toMatch(/waiting will not clear it/i);
        expect(refusal).not.toContain("roughly every 30s");
    });

    it("keeps a still-building deploy in the poll loop", () => {
        const refusal = describeUnfinishedStep("previewkit_deploying", "building");
        expect(refusal).toContain("get_session_status");
        expect(refusal).toContain("roughly every 30s");
    });

    // Both bring-your-own states look the same from the outside ("no preview
    // yet") but need opposite work: one is wiring that does not exist, the other
    // is wiring that exists and has never fired.
    it("separates unwired from wired-but-silent on the customer's own pipeline", () => {
        const configuring = describeUnfinishedStep("existing_deploys_configuring", "idle");
        expect(configuring).toContain("get_signal_setup");
        expect(configuring).toContain("confirm_signal_setup");

        const waiting = describeUnfinishedStep("existing_deploys_waiting", "idle");
        expect(waiting).toContain("Trigger a real deploy");
        expect(waiting).not.toContain("confirm_signal_setup");
    });

    it("points a Vercel app at the Vercel tools rather than a webhook", () => {
        const refusal = describeUnfinishedStep("existing_deploys_configuring", "idle");
        expect(refusal).toContain("link_vercel_project");
    });

    // Rows predating the current flow are not in the step order, so they must not
    // fall through to a message describing a step they are not on.
    it("still says something actionable for a legacy step", () => {
        const refusal = describeUnfinishedStep("webhook_configuring", "idle");
        expect(refusal).toContain("pair");
        expect(refusal).toContain("Autonoma UI");
    });
});

describe("describeUnverifiedPreview", () => {
    // Distinct from a step refusal on purpose: the setup is complete, so an agent
    // told to "configure" here would start editing a config that is already right.
    it("tells the agent to wait rather than reconfigure, and names the live status", () => {
        const refusal = describeUnverifiedPreview("building");
        expect(refusal).toContain("`building`");
        expect(refusal).toMatch(/nothing is missing from the setup/i);
        expect(refusal).toContain("get_session_status");
    });
});

describe("describeWentLive", () => {
    // Going live is optimistic on this path - Autonoma cannot prove the pipeline
    // sends branch+prNumber until a real PR signal lands, so a "you are done"
    // message with no follow-up leaves per-PR reviews silently unwired.
    it("tells a bring-your-own app the per-PR wiring is still unproven", () => {
        const message = describeWentLive("existing_deploys");
        expect(message).toContain("prNumber");
        expect(message).toContain("prReviewsConfirmed");
    });

    it("tells an Autonoma-hosted app there is nothing further to wire", () => {
        const message = describeWentLive("previewkit");
        expect(message).toMatch(/nothing further to wire/i);
        expect(message).not.toContain("prReviewsConfirmed");
    });

    // The UI runs the SDK and recipe work after go-live, so an agent that treats
    // them as a precondition holds onboarding open and keeps PR comments suppressed.
    it("says the SDK and recipes do not gate going live, on either path", () => {
        expect(describeWentLive("previewkit")).toMatch(/going live does not depend on/i);
        expect(describeWentLive("existing_deploys")).toMatch(/going live does not depend on/i);
    });
});

describe("describeAlreadyLive", () => {
    // A retry has to read as "done", not as a knob to keep turning: the earlier
    // transition is resolvable from `completed` and would push the app backwards.
    it("reports done and redirects a missing review to the preview, not the step", () => {
        const message = describeAlreadyLive();
        expect(message).toContain("changed nothing");
        expect(message).toContain("get_signal_status");
        expect(message).toContain("get_session_status");
    });
});
