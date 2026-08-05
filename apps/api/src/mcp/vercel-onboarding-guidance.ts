import type { OnboardingPreviewEnvironmentMode } from "@autonoma/db";
import type { ListAvailableVercelProjectsResult } from "../routes/onboarding/onboarding-vercel-capability";

/**
 * How much of the Vercel integration is in place for one app.
 *
 * Vercel is not a third `previewEnvironmentMode` - it is `existing_deploys`
 * whose signal comes from the Marketplace integration rather than a webhook the
 * customer writes, exactly as the UI models it (a provider tab within "connect
 * your deploys"). So the mode alone cannot tell an agent which of the two to do,
 * and this is what disambiguates it.
 */
export interface VercelState {
    /** The ORG has the Autonoma Vercel Marketplace integration installed. */
    installed: boolean;
    /** THIS app has a Vercel project linked - the point past which the integration is live. */
    linked: boolean;
}

/**
 * Whether the bring-your-own-deploys work here is connecting Vercel rather than
 * wiring a signed webhook. A linked project settles it. An installation with
 * nothing linked yet still counts: the customer installed our integration for a
 * reason, and sending them to hand-write a webhook would build a second, worse
 * signalling path alongside the one they already have - one that still could not
 * reach a protection-enabled preview.
 */
export function isVercelPath(vercel: VercelState): boolean {
    return vercel.installed || vercel.linked;
}

/**
 * The Vercel half of the bring-your-own-deploys path. Vercel is not "their
 * pipeline plus a webhook you write": the Marketplace integration already
 * reports every deployment, so the work is connecting the project rather than
 * writing a signal. Linking is what applies the deployment-protection bypass and
 * adopts the shared secret Vercel injected into their project, so an agent that
 * hand-rolls a signed POST here ends up with previews Autonoma cannot reach and
 * a secret that does not match the one their SDK handler signs with.
 */
export const VERCEL_PLAYBOOK = `This app deploys on **Vercel**, and Autonoma has a Marketplace integration with it - so do NOT write a deployment-signal webhook here. Vercel already tells Autonoma about every deployment once the project is connected. Your job is to connect it and pick the preview to test against.

FIRST, be sure this path is safe for this project - being on Vercel is not itself the reason to be here. On this path Autonoma tests against THEIR deployment, not one we isolate, so every scenario run creates and then deletes rows in whatever database that deployment talks to. A Vercel preview points at the project's own database by default, commonly the same one production uses; only a project that has wired per-preview database branching (Neon, Supabase, PlanetScale) gets a fresh one. So this path is safe only if everything a run creates hangs off a tenant that teardown can delete whole. If the schema has global or shared tables a teardown would leak into - a public catalogue, a listings table, a shared search index - then rows a test creates STAY in that database and real users see them. Check the schema before you continue; if it does not hold up, say so and go back to select_preview_path, because an Autonoma-hosted preview gets its own database and cannot leave anything behind. Getting this wrong the other way only costs a preview we would have built anyway.

1. get_vercel_setup(applicationId) - the state of the connection: whether the org has the Autonoma Vercel integration installed, which projects can be linked, which one is linked already, and the READY deployments once one is. Read \`nextStep\`; it names the call to make.
2. If \`installed\` is false the org has not installed the integration at all, and nothing else here will work. Give the user \`connectUrl\` and ask them to install it, then poll get_vercel_setup (~30s apart) until \`installed\` turns true. You cannot do this step for them.
3. link_vercel_project(applicationId, vercelProjectId) - link the project. Pick the candidate whose \`matchesRepository\` is true: that is the project building the same GitHub repo the app is linked to. If none matches, do NOT guess from the name - ask the user which project it is. Linking is what applies the deployment-protection bypass header (without it Autonoma cannot reach a protected preview) and adopts the \`AUTONOMA_SHARED_SECRET\` Vercel injected into their project, so nothing downstream works until it is done.
4. Now decide which deployment onboarding points at. PREFER TO MAKE ONE rather than reuse something old. The very next thing you do after this is add the Autonoma SDK handler (\`/api/autonoma\`) on its own branch, and Vercel builds a preview for every branch that gets pushed. So make that branch, push it, and use ITS preview: it is the only deployment that will actually contain the handler you are about to write, so onboarding never has to be re-pointed later, and a fresh build picks up the \`AUTONOMA_SHARED_SECRET\` Vercel injects on its own - nothing to rebuild. Poll get_vercel_setup (~30s apart) until a deployment whose \`branch\` is the one you pushed appears, then go to step 6 with its id. Skip step 5 entirely; it exists only for reused deployments.
5. Only if you are REUSING an existing deployment: ask the user which one. Do not choose for them - they know which deployment they want onboarding pointed at and you are inferring it from a branch name and a timestamp. Show them \`deployments\` (each carries \`target\`, \`branch\` and \`createdAt\`); the Autonoma UI asks this exact question with the same list, so you are mirroring it, not adding a step. If their current checkout is on a branch that already has a deployment, offer that one first. NEVER take a \`target: production\` deployment on your own initiative - rebuilding one deploys their live site, and whatever is selected becomes the target of every scenario run, pointing test-data creation and teardown at their LIVE database. Then call create_vercel_deployment(applicationId, vercelDeploymentId) on their choice: an older deployment was built before the shared secret existed, so it needs one rebuild to pick it up. That CREATES a new deployment - a real, live, billable build on their account at a new URL, with its own id, and the id you passed in is not the one you continue with.
6. get_vercel_deployment_status(applicationId, vercelDeploymentId) - poll the deployment you are waiting on every ~30s until \`ready\` is true. A Vercel build takes minutes; keep polling rather than stopping to be told.
7. select_vercel_deployment(applicationId, vercelDeploymentId) - commit the ready deployment as the preview Autonoma tests against. That advances onboarding on its own; there is no confirm step and no signal to wait for.
8. go_live(applicationId) - take the app live. Selecting a deployment advances onboarding but does not take the app live, and until it is live Autonoma reviews no pull requests and holds back the comments it would have posted.

Then carry on with the SDK and scenario recipes below. If you took step 4 you are already on the SDK branch, so keep working there. list_dry_run_targets lists this project's Vercel deployments as targets, so the SDK PR's own preview is what you validate against, and validate_sdk handles a Vercel target directly - you do not need a different tool for it.

Your tools here: get_vercel_setup, link_vercel_project, create_vercel_deployment, get_vercel_deployment_status, select_vercel_deployment, go_live, get_session_status (for the preview URL and your control state - it carries no build logs on this path), plus the SDK and scenario/recipe tools once a deployment is selected.

Not for this app: apply_config, request_env, trigger_deploy and get_target_logs are for Autonoma-hosted previews (Vercel builds these, so Autonoma holds no config and no logs - read build output in Vercel's dashboard). get_signal_setup / get_signal_status / confirm_signal_setup are the hand-wired webhook path, which the integration replaces.`;

/** What `pair` reports about the Vercel connection, alongside the raw flags. */
export interface VercelStateReport {
    installed: boolean;
    projectLinked: boolean;
    meaning: string;
}

/**
 * How `pair` reports the Vercel connection. Flags alone read as trivia an agent
 * skims past, so each state carries the consequence: "installed but not linked"
 * is the one that silently produces unreachable previews if the agent treats
 * this like any other pipeline.
 *
 * Takes the app's mode because deploying on Vercel does NOT decide the path.
 * Plenty of Vercel projects choose Autonoma-hosted previews deliberately - for
 * the isolation of a per-preview database - and for those the Vercel connection
 * is irrelevant. Reporting it unconditionally would contradict the previewkit
 * playbook handed over in the same payload.
 */
export function describeVercelState(
    vercel: VercelState,
    mode: OnboardingPreviewEnvironmentMode | undefined,
): VercelStateReport {
    return {
        installed: vercel.installed,
        projectLinked: vercel.linked,
        meaning: vercelStateMeaning(vercel, mode),
    };
}

function vercelStateMeaning(vercel: VercelState, mode: OnboardingPreviewEnvironmentMode | undefined): string {
    if (mode === "previewkit") {
        return (
            "Not relevant to this app: Autonoma hosts its previews, which is a valid choice on Vercel and a common " +
            "one - an Autonoma-hosted preview gets its own database, so a test run cannot leave rows in whatever " +
            "the project's Vercel previews point at. Ignore the Vercel tools and follow the Autonoma-hosted " +
            "playbook. Only the user can change this, in the Autonoma UI."
        );
    }
    if (!vercel.installed) {
        return (
            "This org has no Autonoma Vercel integration, so if the project deploys elsewhere the signed-webhook " +
            "path (get_signal_setup) is the right one. If the user says they are on Vercel, they need to install " +
            "the integration first - get_vercel_setup returns the link."
        );
    }
    if (vercel.linked) {
        return (
            "A Vercel project is linked, so Vercel already reports every deployment. Do NOT write a " +
            "deployment-signal webhook; use the Vercel tools."
        );
    }
    return (
        "The org has the Vercel integration but this app has no project linked yet, so nothing is reporting " +
        "deployments. Link one with get_vercel_setup / link_vercel_project rather than writing a webhook - linking " +
        "is also what makes protected previews reachable."
    );
}

/**
 * The one call to make next on the Vercel path, spelled out rather than left to
 * be inferred from a bag of flags. The first two states are the ones an agent
 * gets wrong: with no installation it reaches for the webhook, and with an
 * installation but no link it assumes the integration is already doing the work.
 */
export function describeVercelNextStep(
    projects: ListAvailableVercelProjectsResult,
    readyDeploymentCount: number,
    deploymentsUnavailable?: string,
): string {
    if (!projects.connected) {
        const install =
            projects.connectUrl != null
                ? `Send them to ${projects.connectUrl} to install it`
                : "Ask them to install the Autonoma integration from the Vercel marketplace (this environment has " +
                  "no install URL configured, so they will have to find it themselves)";
        return (
            "This org has NOT installed the Autonoma Vercel integration, so Autonoma cannot see their projects at " +
            `all. ${install}, then poll this tool (~30s apart) until \`installed\` is true. You cannot do this step ` +
            "for them, and nothing else on this path works until it is done."
        );
    }
    if (projects.linkedProject == null) {
        return (
            "The integration is installed but this app has no Vercel project linked, so nothing is reporting " +
            "deployments yet. Call link_vercel_project with the candidate whose `matchesRepository` is true (ask " +
            "the user if none matches). Do not write a deployment-signal webhook instead - it would not fix " +
            "reaching a protected preview, which only linking does."
        );
    }
    // Distinguished from a genuinely empty list: "Vercel did not answer" and "this
    // project has never deployed" need opposite responses, and an agent told the
    // wrong one either nags the user to deploy or waits on a build that exists.
    if (deploymentsUnavailable != null) {
        return (
            "The project is linked - that part is done and does not need repeating. Autonoma could not reach " +
            `Vercel to list its deployments (${deploymentsUnavailable}). That is a Vercel-side or credential ` +
            "problem, not something to fix by linking again: if it persists, the installation's access may have " +
            "been revoked and the user needs to reinstall the Autonoma integration on Vercel. Retry this tool " +
            "before concluding anything."
        );
    }
    if (readyDeploymentCount === 0) {
        return (
            "The project is linked but has no READY deployments to choose from. Ask the user to deploy the project " +
            "once on Vercel, then call this tool again."
        );
    }
    return (
        "The project is linked, so now pick what onboarding points at - and prefer making a deployment over " +
        "reusing one. You are about to add the Autonoma SDK handler on its own branch, and Vercel builds a preview " +
        "for every branch pushed, so push that branch and poll this tool until a deployment carrying it appears: " +
        "it is the only one that will contain the handler, and a fresh build already has the injected shared " +
        "secret, so it needs no rebuild - go straight to select_vercel_deployment. To reuse an existing " +
        "deployment instead, ASK the user which (the Autonoma UI asks the same question over this same list), then " +
        "create_vercel_deployment on their choice to rebuild it with the secret, poll " +
        "get_vercel_deployment_status, and select that new id. Never take a `target: production` deployment on " +
        "your own initiative: it deploys their live site, and what you select becomes the target of every scenario " +
        "run, pointing test-data creation and teardown at their live database."
    );
}

/** Vercel's terminal build states, which no amount of further polling will move off. */
const FAILED_VERCEL_READY_STATES: ReadonlySet<string> = new Set(["ERROR", "CANCELED"]);

/** The move to spell out on a Vercel build poll, so a failed build ends the loop instead of extending it. */
export function describeVercelBuildNextStep(ready: boolean, readyState: string): string {
    if (ready) return "Ready. Call select_vercel_deployment with this deployment id to make it the preview.";
    if (FAILED_VERCEL_READY_STATES.has(readyState)) {
        return (
            `The build ended as ${readyState}, so polling will never turn it ready. Vercel built it, so Autonoma ` +
            "holds no logs - read the build output in Vercel's dashboard, fix the cause, and redeploy."
        );
    }
    return `Still building (${readyState}). Wait ~30s and poll again; a Vercel build commonly takes minutes.`;
}
