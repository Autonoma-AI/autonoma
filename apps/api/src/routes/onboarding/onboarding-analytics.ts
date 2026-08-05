import { analytics as analyticsSingleton, type PostHogAnalytics } from "@autonoma/analytics";
import type { OnboardingPreviewEnvironmentMode, OnboardingStep } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

/**
 * PostHog events emitted for the onboarding funnel. Dashboards filter on these
 * names, so they are declared once here rather than typed out at call sites.
 */
const ONBOARDING_EVENT = {
    /** One per onboarding tRPC mutation, with its outcome, latency and failure reason. */
    procedureCalled: "onboarding.procedure_called",
    /** The persisted `step` moved. This is the funnel: one event per stage a user actually reaches. */
    stepChanged: "onboarding.step_changed",
    /** A deployment signal reached the (non-tRPC) signal endpoint, and what it did. */
    deploymentSignal: "onboarding.deployment_signal_received",
} as const;

/** The PostHog group type onboarding is attributed to - one org per customer. */
const ORGANIZATION_GROUP = "organization";

/**
 * Cap on error text carried into an event. A PostHog property is a facet to
 * break a funnel down by, not a log sink - the full error is already in Sentry.
 */
const ERROR_MESSAGE_CAP = 300;

/**
 * The minimal middleware-result shape this layer reads. tRPC hands a failed
 * procedure back as a value rather than a throw, so success cannot be inferred
 * from the absence of an exception.
 */
type ProcedureOutcome = { ok: true } | { ok: false; error: unknown };

/**
 * What drove a step transition.
 *
 * `ui` and `agent` are the two ways a customer does onboarding - by hand, or by
 * pointing a coding agent at the MCP - and they are different products with
 * different failure modes, so a funnel that pools them describes neither. The
 * other two are not user actions at all: `signal` is the customer's CI posting a
 * deployment, and `system` is Autonoma observing its own preview go ready. Both
 * land on `preview_verified`, and both would otherwise be missing from the
 * funnel entirely - see {@link OnboardingAnalytics.stepAdvanced}.
 */
export type OnboardingSurface = "ui" | "agent" | "signal" | "system";

/** The slice of `OnboardingState` every event is annotated with. */
interface StateSnapshot {
    step: OnboardingStep;
    previewEnvironmentMode: OnboardingPreviewEnvironmentMode | undefined;
    startedAt: Date;
}

/** The onboarding row as read here, before it becomes a {@link StateSnapshot}. */
interface OnboardingStateRow {
    step: OnboardingStep;
    previewEnvironmentMode: OnboardingPreviewEnvironmentMode | null;
    createdAt: Date;
}

/**
 * The only query this class makes, named as a capability rather than taking the
 * whole `PrismaClient` - which it structurally satisfies. Narrowing it this far
 * is what lets the emitted events be tested against a row supplied directly,
 * with no database and no assertion.
 */
export interface OnboardingStateReader {
    onboardingState: {
        findUnique(args: {
            where: { applicationId: string };
            select: { step: true; previewEnvironmentMode: true; createdAt: true };
        }): Promise<OnboardingStateRow | null>;
    };
}

export interface OnboardingActor {
    /**
     * PostHog distinct id: the acting user, so client and server events share a
     * funnel. The two machine surfaces have no user - the customer's CI posts the
     * deployment signal, and the readiness poll observes a deploy rather than an
     * action - and pass the organization instead.
     */
    distinctId: string;
    organizationId: string;
    applicationId: string | undefined;
}

export interface DeploymentSignalEvent {
    organizationId: string;
    applicationId: string;
    /** Which branch of the signal handler ran: recorded a preview URL, triggered PR diffs, or was ignored. */
    outcome: "preview_recorded" | "pr_diffs_triggered" | "ignored";
    stepBefore: OnboardingStep;
    previewEnvironmentMode: OnboardingPreviewEnvironmentMode | undefined;
}

/**
 * Emits the onboarding funnel to PostHog.
 *
 * Two events do the work. {@link ONBOARDING_EVENT.stepChanged} is the funnel
 * itself - a stage counts only once the server persisted it, so a step someone
 * opened but never completed cannot inflate it. {@link
 * ONBOARDING_EVENT.procedureCalled} is the failure surface underneath: which
 * action a user retried, how long it took, and what it failed with. Together
 * they answer "which stage do people stall on, and what stalls them" without a
 * capture call in any handler.
 *
 * `distinctId` is the acting user's id, matching `posthog.identify` in the
 * browser, so the client-side steps (`onboarding.opened`,
 * `onboarding.step_viewed`) and these server-side ones sit in one funnel. The
 * deployment-signal endpoint has no user - it is called by the customer's CI -
 * and is attributed to the organization instead.
 *
 * Analytics never breaks a request: every emit path swallows its own failure
 * into a warning.
 */
export class OnboardingAnalytics {
    private readonly logger: Logger;

    constructor(
        private readonly db: OnboardingStateReader,
        private readonly analytics: PostHogAnalytics = analyticsSingleton,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Run one onboarding mutation and record it. Reads the persisted step either
     * side of `run`, so a transition is observed wherever it was written - the
     * state machine, a capability service, or a preview-URL write nested several
     * layers down - rather than only where a handler remembered to say so.
     *
     * Deliberately not applied to queries: the onboarding UI polls `getState`,
     * `getAgentSession` and `getPreviewReadiness` continuously, so instrumenting
     * reads would bury the funnel in poll traffic and put two extra round-trips
     * on every poll. A failing read is already captured browser-side by the
     * React Query error handler.
     *
     * Returns `run`'s result untouched, and re-throws whatever it threw.
     */
    async trackMutation<T extends ProcedureOutcome>(
        actor: OnboardingActor,
        procedure: string,
        run: () => Promise<T>,
    ): Promise<T> {
        const before = await this.readState(actor.applicationId);
        const startedAt = Date.now();

        try {
            const result = await run();
            await this.record(actor, procedure, startedAt, before, result.ok ? undefined : result.error);
            return result;
        } catch (err) {
            await this.record(actor, procedure, startedAt, before, err);
            throw err;
        }
    }

    /**
     * Run one MCP-driven onboarding write and record any step it moved the app to.
     *
     * Emits the transition ONLY. A coding agent's tool calls are already covered
     * end to end by `mcp.tool_called` (tool, success, latency, org), so a second
     * per-call event here would double-count; what that event cannot see is which
     * funnel stage the write landed on. Recording it means an agent-driven
     * onboarding appears in the same funnel as a hand-driven one, tagged
     * `surface: "agent"` so the two can be compared instead of pooled.
     */
    async trackAgentWrite<T>(actor: OnboardingActor, tool: string, run: () => Promise<T>): Promise<T> {
        const before = await this.readState(actor.applicationId);
        const result = await run();
        this.emitStepChange(actor, tool, "agent", before?.step, await this.readState(actor.applicationId));
        return result;
    }

    /**
     * Report a transition the caller already knows it made, rather than one
     * inferred from a before/after diff.
     *
     * This is how `preview_verified` - the funnel's central conversion - gets
     * counted for the paths no tracker wraps. It is stamped by `writePreviewUrl`,
     * which is reached three ways: a tRPC mutation (the Vercel deployment
     * selection, whose transition the middleware already sees), the customer's CI
     * posting a deployment signal, and the readiness poll observing an
     * Autonoma-hosted preview go ready. The latter two are a raw HTTP handler and
     * a polled query, so without this they would be missing from the funnel and
     * `preview_verified` would appear to happen only for Vercel customers.
     *
     * The caller passes `fromStep` from `writePreviewUrl`'s own result, so the
     * "did it advance?" condition has exactly one definition.
     */
    async stepAdvanced(
        actor: OnboardingActor,
        action: string,
        surface: OnboardingSurface,
        fromStep: OnboardingStep,
    ): Promise<void> {
        this.emitStepChange(actor, action, surface, fromStep, await this.readState(actor.applicationId));
    }

    /**
     * A deployment signal landed on the signal endpoint. Emitted separately
     * because that endpoint is not a tRPC procedure: on the bring-your-own-deploys
     * path it is the only thing that advances onboarding, so without it a customer
     * whose CI never posts one looks identical to one who never tried.
     */
    deploymentSignalReceived(event: DeploymentSignalEvent): void {
        this.capture(event.organizationId, event.organizationId, ONBOARDING_EVENT.deploymentSignal, {
            applicationId: event.applicationId,
            outcome: event.outcome,
            stepBefore: event.stepBefore,
            previewEnvironmentMode: event.previewEnvironmentMode,
        });
    }

    private async record(
        actor: OnboardingActor,
        procedure: string,
        startedAt: number,
        before: StateSnapshot | undefined,
        err: unknown,
    ): Promise<void> {
        const after = await this.readState(actor.applicationId);
        // The step the user was ON when they took this action - what a failure
        // breakdown needs. Where they ended up is the transition event.
        const properties: Record<string, unknown> = {
            procedure,
            success: err == null,
            durationMs: Date.now() - startedAt,
            applicationId: actor.applicationId,
            step: before?.step ?? after?.step,
            previewEnvironmentMode: before?.previewEnvironmentMode ?? after?.previewEnvironmentMode,
        };
        if (err != null) {
            properties.errorName = errorName(err);
            properties.errorMessage = errorMessage(err);
        }
        this.capture(actor.distinctId, actor.organizationId, ONBOARDING_EVENT.procedureCalled, properties);

        this.emitStepChange(actor, procedure, "ui", before?.step, after);
    }

    private emitStepChange(
        actor: OnboardingActor,
        action: string,
        surface: OnboardingSurface,
        fromStep: OnboardingStep | undefined,
        after: StateSnapshot | undefined,
    ): void {
        if (fromStep == null || after == null || fromStep === after.step) return;

        this.capture(actor.distinctId, actor.organizationId, ONBOARDING_EVENT.stepChanged, {
            applicationId: actor.applicationId,
            fromStep,
            toStep: after.step,
            previewEnvironmentMode: after.previewEnvironmentMode,
            // What moved it, so a stage reached off the happy path (a self-healing
            // redeploy, a signal) is distinguishable from one reached on it.
            action,
            surface,
            secondsSinceStarted: Math.round((Date.now() - after.startedAt.getTime()) / 1000),
        });
    }

    /** Undefined when there is no application in scope yet, or no onboarding row for it. */
    private async readState(applicationId: string | undefined): Promise<StateSnapshot | undefined> {
        if (applicationId == null) return undefined;

        try {
            const row = await this.db.onboardingState.findUnique({
                where: { applicationId },
                select: { step: true, previewEnvironmentMode: true, createdAt: true },
            });
            if (row == null) return undefined;
            return {
                step: row.step,
                previewEnvironmentMode: row.previewEnvironmentMode ?? undefined,
                startedAt: row.createdAt,
            };
        } catch (err) {
            this.logger.warn("Could not read onboarding state for analytics", { applicationId, err });
            return undefined;
        }
    }

    private capture(
        distinctId: string,
        organizationId: string,
        event: string,
        properties: Record<string, unknown>,
    ): void {
        try {
            this.analytics.capture(
                distinctId,
                event,
                { ...properties, organizationId },
                { [ORGANIZATION_GROUP]: organizationId },
            );
        } catch (err) {
            this.logger.warn("Failed to capture onboarding event", { extra: { event }, err });
        }
    }
}

function errorName(err: unknown): string {
    return err instanceof Error ? err.name : typeof err;
}

function errorMessage(err: unknown): string {
    const message = err instanceof Error ? err.message : String(err);
    return message.slice(0, ERROR_MESSAGE_CAP);
}
