import * as p from "../ui/prompts";
import { debugLog } from "./debug";
import { sleep } from "./errors";
import { captureLog } from "./logs";

/** How often a preview's deploy state is re-read while waiting for it to come up. */
const TARGET_POLL_MS = 10_000;

/**
 * Ceiling on waiting for a preview to build. Generous, because it covers a cold
 * image build of someone else's app, but finite: a preview that never arrives has to
 * end the phase with a reason rather than hold the run open forever.
 */
const TARGET_READY_TIMEOUT_MS = 20 * 60_000;

/**
 * How long a target with no preview environment at all is given to grow one.
 *
 * Much shorter than the build ceiling, because the two states mean different things.
 * A pull request opened moments ago reads `no_preview` until the webhook creates its
 * environment, and that transition is worth catching. A draft pull request reads the
 * same and will never change - nothing is building, so waiting the full build
 * deadline spends twenty minutes to report "still building" about something that
 * never started.
 */
const NO_PREVIEW_GRACE_MS = 60_000;

/**
 * How many scenario failures are quoted back before the rest are counted. The whole
 * list is in the Autonoma app; a terminal summary that scrolls past the top of the
 * screen tells the user less than a short one, not more.
 */
const MAX_QUOTED_FAILURES = 3;

/**
 * The statuses the API answers a preview's readiness with. Copied rather than
 * imported because the CLI is published to npm and cannot depend on the API at
 * runtime - but the copy is checked, not hopeful: {@link DryRunReader} is satisfied
 * structurally by the typed client, so a status renamed on the API fails this
 * package's typecheck.
 */
type TargetAvailability = "ready" | "building" | "failed" | "no_preview";

/** A preview environment a dry run can be pointed at. */
export interface DryRunTarget {
    id: string;
    label: string;
    /** Who deploys it: Autonoma, Vercel, or the project's own pipeline. */
    source: "previewkit" | "external" | "vercel";
    availability: TargetAvailability;
    /** Why the preview is unusable, when its deploy failed. */
    error?: string;
    /** Absent until the preview has actually deployed. */
    sdkUrl?: string;
}

/**
 * What this phase needs of the Autonoma client, and no more. `AutonomaClient`
 * satisfies it structurally, so nothing has to be threaded or cast at the call site.
 */
export interface DryRunReader {
    listDryRunTargets(applicationId: string): Promise<{ targets: DryRunTarget[]; autoDetectedTargetId?: string }>;
    listScenarios(applicationId: string): Promise<{ id: string; name: string }[]>;
    prepareSdkTarget(applicationId: string, targetId: string): Promise<{ status: "ready" | "redeploy_started" }>;
    configureAndDiscoverSdkTarget(
        applicationId: string,
        targetId: string,
        allowSelfHeal: boolean,
    ): Promise<{ status: "discovered" | "redeploy_started" }>;
    runScenarioDryRun(
        applicationId: string,
        scenarioId: string,
        targetId: string,
    ): Promise<{ success: boolean; phase?: string; error?: unknown }>;
}

export interface DryRunPhaseDeps {
    client: DryRunReader;
    applicationId: string;
    /** Overridable so tests do not wait real minutes. */
    timing?: DryRunTiming;
}

export interface DryRunTiming {
    pollMs: number;
    readyTimeoutMs: number;
    /** Ceiling on waiting for a preview environment to exist at all. */
    noPreviewGraceMs: number;
}

const DEFAULT_TIMING: DryRunTiming = {
    pollMs: TARGET_POLL_MS,
    readyTimeoutMs: TARGET_READY_TIMEOUT_MS,
    noPreviewGraceMs: NO_PREVIEW_GRACE_MS,
};

/** One scenario that did not survive its up/down cycle. */
export interface DryRunFailure {
    scenario: string;
    /** Which leg failed - provisioning the data, or tearing it back down. */
    phase?: string;
    reason?: string;
}

/** How the dry run ended, for the caller to report and decide on. */
export type DryRunPhaseOutcome =
    | { kind: "passed"; scenarios: number }
    | { kind: "failed"; passed: number; failures: DryRunFailure[] }
    /** The app has no scenarios, so there is nothing to provision. */
    | { kind: "no-scenarios" }
    /** No preview came up to run against. */
    | { kind: "no-target"; reason: string }
    /** A preview exists, but validating it is not something the CLI can do. */
    | { kind: "unsupported-target"; reason: string }
    /** The SDK handler did not answer, so the scenarios were never attempted. */
    | { kind: "discovery-failed"; reason: string };

/**
 * Validate the app's SDK handler against a preview and provision every scenario
 * through it.
 *
 * These are ordinary API calls made with the credentials this run already holds, so
 * the CLI makes them itself rather than asking the coding agent to make them through
 * the MCP. Routing an API call through an agent adds no judgement and one more way
 * for it not to happen; the agent keeps the work that needs the repo.
 */
export async function runDryRunPhase(deps: DryRunPhaseDeps): Promise<DryRunPhaseOutcome> {
    const timing = deps.timing ?? DEFAULT_TIMING;
    const { client, applicationId } = deps;

    const [scenarios, listing] = await Promise.all([
        client.listScenarios(applicationId),
        client.listDryRunTargets(applicationId),
    ]);

    if (scenarios.length === 0) {
        captureLog("info", "No scenarios to dry run", { source: "dry_run" });
        return { kind: "no-scenarios" };
    }

    const chosen = pickDryRunTarget(listing);
    if (chosen == null) {
        return {
            kind: "no-target",
            reason:
                "Autonoma has no preview environment to run your scenarios against yet. Open a pull request (or " +
                "wait for your main preview to deploy) and run again.",
        };
    }

    const unsupported = describeUnsupportedTarget(chosen);
    if (unsupported != null) return { kind: "unsupported-target", reason: unsupported };

    p.log.info(`Checking your Autonoma SDK against the "${chosen.label}" preview...`);
    const target = await waitForReadyTarget(client, applicationId, chosen, timing);
    if (target.kind === "gone") return { kind: "no-target", reason: target.reason };

    const discovery = await discoverSdk(client, applicationId, target.target, timing);
    if (discovery != null) return { kind: "discovery-failed", reason: discovery };

    return await dryRunScenarios(client, applicationId, target.target.id, scenarios);
}

/**
 * Which preview to run against. The platform flags the pull request carrying the SDK
 * handler, and that is the one to use even while it is still building: it is the only
 * preview whose code contains the handler the scenarios need. Failing that, any
 * preview that is already up will do.
 */
export function pickDryRunTarget(listing: {
    targets: DryRunTarget[];
    autoDetectedTargetId?: string;
}): DryRunTarget | undefined {
    const detected = listing.targets.find((target) => target.id === listing.autoDetectedTargetId);
    if (detected != null) return detected;
    return listing.targets.find((target) => target.availability === "ready");
}

/**
 * Why the CLI cannot validate this preview itself, or undefined when it can.
 *
 * Autonoma deploys its own previews and holds both halves of their credentials, so
 * those it can validate unattended. The other two it cannot, for reasons that are not
 * gaps to fill later: a preview from the project's own pipeline is signed with a
 * secret only the user holds, and a Vercel deployment is validated against the
 * deployment the user picked in the app, which the CLI has no basis to choose.
 */
function describeUnsupportedTarget(target: DryRunTarget): string | undefined {
    if (target.source === "previewkit") return undefined;
    if (target.source === "vercel") {
        return (
            `Your previews are built by Vercel, so the scenario dry run runs against the deployment you pick. ` +
            `Choose it on the SDK step in the Autonoma app and validate there - everything else in this run is done.`
        );
    }
    return (
        `Your previews come from your own pipeline, and validating one needs the signing secret your pipeline ` +
        `signs with - which never leaves your side. Enter it on the SDK step in the Autonoma app to finish - ` +
        `everything else in this run is done.`
    );
}

/** A preview that came up, or the reason it never did. */
type ReadyTarget = { kind: "ready"; target: DryRunTarget } | { kind: "gone"; reason: string };

/**
 * Wait for the chosen preview to deploy.
 *
 * A preview that is still building - or that a webhook has not caught up with at all
 * yet, which is what a just-opened pull request looks like for a few seconds - is
 * worth waiting on. A deploy that has actually failed is not: it fails the same way
 * on every poll, and the reason it carries is more use to the user than a timeout.
 *
 * The two waits are bounded separately, because "building" and "no preview at all"
 * are not the same wait. See {@link NO_PREVIEW_GRACE_MS}.
 */
async function waitForReadyTarget(
    client: Pick<DryRunReader, "listDryRunTargets">,
    applicationId: string,
    initial: DryRunTarget,
    timing: DryRunTiming,
): Promise<ReadyTarget> {
    const startedAt = Date.now();
    const deadline = startedAt + timing.readyTimeoutMs;
    // Never outlast the build ceiling, however the grace window is configured.
    const noPreviewDeadline = startedAt + Math.min(timing.noPreviewGraceMs, timing.readyTimeoutMs);
    let target = initial;

    while (true) {
        if (target.availability === "ready") return { kind: "ready", target };
        if (target.availability === "failed") {
            return {
                kind: "gone",
                reason:
                    `The "${target.label}" preview failed to deploy, so there is nothing to run your scenarios ` +
                    `against${target.error != null ? `: ${target.error}` : "."}`,
            };
        }
        // Named rather than folded into the build timeout: a draft pull request sits
        // here forever, and "still building after 20 minutes" would describe a build
        // that never started and send the user looking for a failure that isn't there.
        if (target.availability === "no_preview" && Date.now() >= noPreviewDeadline) {
            return {
                kind: "gone",
                reason:
                    `The "${target.label}" pull request has no preview environment, so there is nothing to run ` +
                    `your scenarios against. A draft pull request does not get one - mark it ready for review ` +
                    `so a preview builds, then run again.`,
            };
        }
        if (Date.now() >= deadline) {
            return {
                kind: "gone",
                reason:
                    `The "${target.label}" preview was still building after ` +
                    `${Math.round(timing.readyTimeoutMs / 60_000)} minutes, so the scenario dry run was skipped. ` +
                    `Run again once it is up.`,
            };
        }

        debugLog("Waiting for the dry-run preview to deploy", {
            target: target.id,
            availability: target.availability,
        });
        await sleep(timing.pollMs);

        const listing = await client.listDryRunTargets(applicationId).catch((err: unknown) => {
            // One dropped request must not end a phase that is otherwise working; the
            // next poll asks again, and the deadline still bounds the wait.
            debugLog("Could not re-read the dry-run targets", { err });
            return undefined;
        });
        const refreshed = listing?.targets.find((candidate) => candidate.id === target.id);
        if (refreshed != null) target = refreshed;
    }
}

/**
 * Provision the preview's Autonoma secrets, then call the SDK handler and store the
 * schema it reports. Returns the reason it did not work, or undefined on success.
 *
 * Both steps can answer "the preview is redeploying" instead of a result - mounting a
 * secret changes the running app, and so does healing a signature the app rejected.
 * Each is worth waiting out once, because the redeploy is the fix; a rejection that
 * survives one is a real failure and is reported rather than redeployed through again.
 */
async function discoverSdk(
    client: DryRunReader,
    applicationId: string,
    target: DryRunTarget,
    timing: DryRunTiming,
): Promise<string | undefined> {
    try {
        const prepared = await client.prepareSdkTarget(applicationId, target.id);
        if (prepared.status === "redeploy_started") {
            p.log.info(`Redeploying the "${target.label}" preview with its Autonoma secrets...`);
            const back = await waitForRedeploy(client, applicationId, target, timing);
            if (back != null) return back;
        }

        for (const allowSelfHeal of [true, false]) {
            const result = await client.configureAndDiscoverSdkTarget(applicationId, target.id, allowSelfHeal);
            if (result.status === "discovered") {
                p.log.success("Your Autonoma SDK answered - Autonoma knows your data models.");
                captureLog("info", "SDK discovery succeeded", { source: "dry_run", target: target.id });
                return undefined;
            }
            p.log.info(`Refreshing the "${target.label}" preview's Autonoma secrets...`);
            const back = await waitForRedeploy(client, applicationId, target, timing);
            if (back != null) return back;
        }

        // Only reachable if the retry also asked for a redeploy, which it cannot: the
        // second attempt disallows self-healing, so it either discovers or throws.
        return `The "${target.label}" preview kept redeploying instead of answering. Try again from the Autonoma app.`;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        captureLog("warn", "SDK discovery failed", { source: "dry_run", target: target.id });
        return (
            `Your Autonoma SDK endpoint didn't answer, so the scenario dry run was skipped: ${message}\n` +
            `Its own logs are on the SDK step in the Autonoma app, which is also where you can retry.`
        );
    }
}

/** Wait out a redeploy the API just started, returning the reason it did not come back. */
async function waitForRedeploy(
    client: Pick<DryRunReader, "listDryRunTargets">,
    applicationId: string,
    target: DryRunTarget,
    timing: DryRunTiming,
): Promise<string | undefined> {
    // A redeploy the API has only just requested may not have flipped the preview off
    // "ready" yet, so start the wait from a state that cannot end it immediately.
    const back = await waitForReadyTarget(client, applicationId, { ...target, availability: "building" }, timing);
    return back.kind === "ready" ? undefined : back.reason;
}

/**
 * Provision every scenario against the preview and tear it back down again. Runs them
 * one at a time: they write to the app's own database, and two provisioning at once
 * would be testing something nobody asked for.
 *
 * A dry run reports failure two ways - it resolves saying the SDK rejected the data,
 * or it throws because the recipe never resolved far enough to be sent. The second
 * leaves no trace anywhere else, so it is caught here rather than ending the phase.
 */
async function dryRunScenarios(
    client: Pick<DryRunReader, "runScenarioDryRun">,
    applicationId: string,
    targetId: string,
    scenarios: { id: string; name: string }[],
): Promise<DryRunPhaseOutcome> {
    p.log.info(`Running ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"} against your preview...`);

    const failures: DryRunFailure[] = [];
    for (const scenario of scenarios) {
        const result = await client
            .runScenarioDryRun(applicationId, scenario.id, targetId)
            .catch((err: unknown) => ({ success: false, phase: undefined, error: err }));

        if (result.success) {
            p.log.success(`${scenario.name} - provisioned and torn down.`);
            continue;
        }

        const failure: DryRunFailure = {
            scenario: scenario.name,
            phase: result.phase,
            reason: formatDryRunError(result.error),
        };
        failures.push(failure);
        p.log.warn(`${scenario.name} - failed${failure.reason != null ? `: ${failure.reason}` : "."}`);
    }

    const passed = scenarios.length - failures.length;
    captureLog(failures.length > 0 ? "warn" : "info", "Scenario dry run finished", {
        source: "dry_run",
        scenario_count: scenarios.length,
        passed_count: passed,
    });

    if (failures.length === 0) return { kind: "passed", scenarios: scenarios.length };
    return { kind: "failed", passed, failures };
}

/**
 * Why a dry run failed, from either way one can end. The resolved failure carries a
 * structured error typed `unknown` over the wire; the thrown one carries an Error.
 */
function formatDryRunError(error: unknown): string | undefined {
    if (error == null) return undefined;
    if (typeof error === "string") return error.length > 0 ? error : undefined;
    if (error instanceof Error) return error.message;
    return JSON.stringify(error);
}

/** What to tell the user when the dry run did not confirm their scenarios. */
export function describeDryRunOutcome(outcome: DryRunPhaseOutcome): string | undefined {
    if (outcome.kind === "passed") return undefined;
    if (outcome.kind === "no-scenarios") {
        return (
            "There were no scenarios to provision, so nothing was dry run. Autonoma's tests will run against " +
            "whatever state your app is already in."
        );
    }
    if (outcome.kind === "no-target" || outcome.kind === "unsupported-target") return outcome.reason;
    if (outcome.kind === "discovery-failed") return outcome.reason;

    const quoted = outcome.failures
        .slice(0, MAX_QUOTED_FAILURES)
        .map((failure) => {
            const where = failure.phase != null ? ` (${failure.phase})` : "";
            return `  - ${failure.scenario}${where}${failure.reason != null ? `: ${failure.reason}` : ""}`;
        })
        .join("\n");
    const rest = outcome.failures.length - MAX_QUOTED_FAILURES;

    return (
        `${outcome.failures.length} of ${outcome.failures.length + outcome.passed} scenarios could not be ` +
        `provisioned:\n${quoted}${rest > 0 ? `\n  ...and ${rest} more` : ""}\n` +
        `Fix them on the dry-run step in the Autonoma app, where a coding agent can read your SDK's own logs.`
    );
}
