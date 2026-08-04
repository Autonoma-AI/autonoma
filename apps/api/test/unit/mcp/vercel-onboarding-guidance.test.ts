import { describe, expect, it } from "vitest";
import {
    VERCEL_PLAYBOOK,
    describeVercelBuildNextStep,
    describeVercelNextStep,
    describeVercelState,
    isVercelPath,
} from "../../../src/mcp/vercel-onboarding-guidance";
import type { ListAvailableVercelProjectsResult } from "../../../src/routes/onboarding/onboarding-vercel-capability";

const CONNECT_URL = "https://vercel.com/integrations/autonoma/new";

function projects(overrides: Partial<ListAvailableVercelProjectsResult> = {}): ListAvailableVercelProjectsResult {
    return {
        connected: overrides.connected ?? true,
        projects: overrides.projects ?? [],
        // Keyed on presence, not `??`: an explicit `connectUrl: undefined` is the
        // case under test (an environment with no install URL configured), and a
        // nullish default would silently substitute the URL back in.
        connectUrl: "connectUrl" in overrides ? overrides.connectUrl : CONNECT_URL,
        linkedProject: overrides.linkedProject,
    };
}

describe("isVercelPath", () => {
    it("is false for an org with no Vercel integration, so those apps get the webhook path", () => {
        expect(isVercelPath({ installed: false, linked: false })).toBe(false);
    });

    it("is true once a project is linked", () => {
        expect(isVercelPath({ installed: true, linked: true })).toBe(true);
    });

    // The bug this guards: an installed-but-unlinked app used to read as a plain
    // bring-your-own pipeline, so the agent hand-wrote a signed webhook that could
    // never reach a protection-enabled preview.
    it("is true when the integration is installed but nothing is linked yet", () => {
        expect(isVercelPath({ installed: true, linked: false })).toBe(true);
    });
});

describe("describeVercelState", () => {
    it("tells an agent on a linked app not to write a webhook", () => {
        const report = describeVercelState({ installed: true, linked: true }, "existing_deploys");
        expect(report.projectLinked).toBe(true);
        expect(report.meaning).toContain("Do NOT write a deployment-signal webhook");
    });

    it("tells an installed-but-unlinked app to link rather than wire a signal", () => {
        const report = describeVercelState({ installed: true, linked: false }, "existing_deploys");
        expect(report.meaning).toContain("link_vercel_project");
        expect(report.meaning).toContain("reachable");
    });

    it("points an org with no integration at the webhook path", () => {
        const report = describeVercelState({ installed: false, linked: false }, undefined);
        expect(report.installed).toBe(false);
        expect(report.meaning).toContain("get_signal_setup");
    });

    // Deploying on Vercel does not decide the path: choosing Autonoma-hosted for
    // the per-preview database is normal. Reporting Vercel guidance here would
    // contradict the previewkit playbook shipped in the same `pair` payload.
    it("stands down on a Vercel project that chose Autonoma-hosted previews", () => {
        const report = describeVercelState({ installed: true, linked: false }, "previewkit");
        expect(report.installed).toBe(true);
        expect(report.meaning).toContain("Not relevant to this app");
        expect(report.meaning).not.toContain("link_vercel_project");
    });

    it("stands down even when a Vercel project is already linked", () => {
        const report = describeVercelState({ installed: true, linked: true }, "previewkit");
        expect(report.projectLinked).toBe(true);
        expect(report.meaning).toContain("Ignore the Vercel tools");
    });
});

describe("describeVercelNextStep", () => {
    it("asks the user to install the integration, with the URL, when the org has none", () => {
        const step = describeVercelNextStep(projects({ connected: false }), 0);
        expect(step).toContain(CONNECT_URL);
        expect(step).toContain("cannot do this step for them");
    });

    it("still says what to do when the environment has no install URL configured", () => {
        const step = describeVercelNextStep(projects({ connected: false, connectUrl: undefined }), 0);
        expect(step).toContain("Vercel marketplace");
        expect(step).not.toContain("undefined");
    });

    it("routes an installed org with nothing linked to link_vercel_project", () => {
        const step = describeVercelNextStep(projects(), 0);
        expect(step).toContain("link_vercel_project");
        expect(step).toContain("matchesRepository");
    });

    it("asks for a deploy when the project is linked but has no ready deployments", () => {
        const step = describeVercelNextStep(projects({ linkedProject: { id: "prj_1", name: "acme-web" } }), 0);
        expect(step).toContain("no READY deployments");
    });

    // "Vercel did not answer" and "this project has never deployed" both arrive as
    // zero deployments but need opposite responses - one is retry, the other is
    // "ask the user to deploy". Conflating them either nags the user for a deploy
    // that exists or waits on a build that does not.
    it("separates an unreachable Vercel from a project that has never deployed", () => {
        const step = describeVercelNextStep(
            projects({ linkedProject: { id: "prj_1", name: "acme-web" } }),
            0,
            "Vercel installation has no access token",
        );
        expect(step).toContain("could not reach");
        expect(step).toContain("Vercel installation has no access token");
        expect(step).not.toContain("no READY deployments");
    });

    // The dead-end this closes: the link committed, the deployments read failed,
    // the agent read that as a failed link and retried into "already linked".
    it("tells an agent the link is done when only the deployment read failed", () => {
        const step = describeVercelNextStep(
            projects({ linkedProject: { id: "prj_1", name: "acme-web" } }),
            0,
            "connect ETIMEDOUT",
        );
        expect(step).toContain("does not need repeating");
        expect(step).not.toContain("link_vercel_project");
    });

    it("routes a linked project with deployments to the redeploy/poll/select sequence", () => {
        const step = describeVercelNextStep(projects({ linkedProject: { id: "prj_1", name: "acme-web" } }), 3);
        expect(step).toContain("create_vercel_deployment");
        expect(step).toContain("select_vercel_deployment");
    });

    // Safety-critical: the selected deployment is where every scenario run creates
    // and deletes rows, so steering an agent at the production one points test-data
    // teardown at the customer's live database (and redeploys their live site).
    it("never steers the deployment choice at production on the agent's own initiative", () => {
        const step = describeVercelNextStep(projects({ linkedProject: { id: "prj_1", name: "acme-web" } }), 3);
        expect(step).toMatch(/never take a `target: production`/i);
        expect(step).not.toMatch(/prefer the production/i);
    });

    // Reuse is the fallback, and the UI asks the user over this same list - so the
    // agent mirroring it is parity, not an extra prompt it invented.
    it("hands the reuse choice back to the user rather than inferring it", () => {
        const step = describeVercelNextStep(projects({ linkedProject: { id: "prj_1", name: "acme-web" } }), 3);
        expect(step).toMatch(/ASK the user/i);
    });

    // The point of branching first: that preview is the only one containing the
    // handler about to be written, so onboarding never gets re-pointed later.
    it("prefers pushing the SDK branch over reusing an old deployment", () => {
        const step = describeVercelNextStep(projects({ linkedProject: { id: "prj_1", name: "acme-web" } }), 3);
        expect(step).toMatch(/prefer making a deployment over reusing/i);
        expect(step).toContain("needs no rebuild");
    });
});

describe("VERCEL_PLAYBOOK", () => {
    // Arriving from the Vercel marketplace is exactly the funnel where an agent
    // skips the isolation trade-off, so the playbook has to restate it rather than
    // reading as "you have the integration, therefore connect it".
    it("makes the isolation trade-off a precondition, not just the mechanics", () => {
        expect(VERCEL_PLAYBOOK).toContain("being on Vercel is not itself the reason to be here");
        expect(VERCEL_PLAYBOOK).toContain("tenant");
        expect(VERCEL_PLAYBOOK).toContain("select_preview_path");
    });

    it("warns that a Vercel preview shares the project's real database by default", () => {
        expect(VERCEL_PLAYBOOK).toContain("same one production uses");
        expect(VERCEL_PLAYBOOK).toMatch(/database branching/i);
    });

    it("does not tell the agent to reach for the production deployment", () => {
        expect(VERCEL_PLAYBOOK).not.toMatch(/prefer the production/i);
        expect(VERCEL_PLAYBOOK).toMatch(/NEVER take a `target: production` deployment on your own initiative/i);
    });

    // Branching first means the preview already contains the SDK handler, so
    // onboarding is not pointed at a deployment that has to be replaced later.
    it("leads with creating the SDK branch's own preview rather than reusing one", () => {
        expect(VERCEL_PLAYBOOK).toContain("PREFER TO MAKE ONE");
        expect(VERCEL_PLAYBOOK).toContain("never has to be re-pointed later");
    });

    it("keeps the rebuild as the reuse-only fallback, and asks the user which to reuse", () => {
        expect(VERCEL_PLAYBOOK).toContain("Only if you are REUSING an existing deployment: ask the user which one");
        expect(VERCEL_PLAYBOOK).toContain("it exists only for reused deployments");
    });
});

describe("describeVercelBuildNextStep", () => {
    it("moves on to selecting once the build is ready", () => {
        expect(describeVercelBuildNextStep(true, "READY")).toContain("select_vercel_deployment");
    });

    it("keeps a still-building deployment in the poll loop", () => {
        expect(describeVercelBuildNextStep(false, "BUILDING")).toContain("poll again");
    });

    // A failed build never turns ready, so an agent told only "not ready" polls forever.
    it("ends the poll loop on a terminal failure and says where the logs are", () => {
        const step = describeVercelBuildNextStep(false, "ERROR");
        expect(step).toContain("polling will never turn it ready");
        expect(step).toContain("Vercel's dashboard");
        expect(step).not.toContain("poll again");
    });

    it("treats a canceled build as terminal too", () => {
        expect(describeVercelBuildNextStep(false, "CANCELED")).toContain("polling will never turn it ready");
    });
});
