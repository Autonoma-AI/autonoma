import { analytics as analyticsSingleton, type PostHogAnalytics } from "@autonoma/analytics";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

/**
 * PostHog events for the Vercel Marketplace half of onboarding - everything that
 * happens before a user reaches `/onboarding`, plus the churn that happens after.
 *
 * `vercel.installation_completed` is emitted from the installations router
 * itself and predates this class; it stays there so its existing (snake_case)
 * properties are not broken.
 */
const VERCEL_EVENT = {
    /** The resource is provisioned and its credentials are on their way into the customer's project env. */
    resourceCreated: "vercel.resource_created",
    /** Resource creation reached the point of handing back credentials and could not produce them. */
    resourceProvisioningFailed: "vercel.resource_provisioning_failed",
    resourceDeleted: "vercel.resource_deleted",
    planChanged: "vercel.plan_changed",
    /** The integration was uninstalled - the churn counterpart of `vercel.installation_completed`. */
    installationDeleted: "vercel.installation_deleted",
    /** A Marketplace OAuth callback produced a session, in install or SSO mode. */
    authCompleted: "vercel.auth_completed",
    /** A Marketplace OAuth callback dead-ended at `/login?error=...`. */
    authFailed: "vercel.auth_failed",
} as const;

/** The PostHog group type Vercel activity is attributed to - one org per customer. */
const ORGANIZATION_GROUP = "organization";

/**
 * Distinct id for a callback that failed before it resolved anyone. Paired with
 * `$process_person_profile: false` so these never accrete onto a shared person.
 */
const ANONYMOUS_DISTINCT_ID = "vercel-marketplace";

/** Which leg of the Marketplace OAuth chain a callback was on. */
export type VercelAuthMode = "install" | "sso";

interface OrgScope {
    /**
     * PostHog distinct id: the Autonoma user the installation belongs to where one
     * is resolved, the organization otherwise. Vercel calls several of these
     * endpoints machine-to-machine, and an event attributed to the org still lands
     * in the right customer's funnel.
     */
    distinctId: string;
    organizationId: string;
}

interface ResourceCreatedEvent extends OrgScope {
    installationId: string;
    resourceId: string;
    productId: string;
    planId: string;
    planName: string;
}

interface ResourceProvisioningFailedEvent extends OrgScope {
    installationId: string;
    resourceId: string;
}

interface ResourceDeletedEvent extends OrgScope {
    installationId: string;
    resourceId: string;
}

interface PlanChangedEvent extends OrgScope {
    installationId: string;
    planId: string;
    planName: string;
}

interface InstallationDeletedEvent extends OrgScope {
    installationId: string;
    /** How many resources went with it - zero means they uninstalled before ever provisioning one. */
    resourceCount: number;
    daysInstalled: number;
}

interface AuthCompletedEvent extends OrgScope {
    mode: VercelAuthMode;
}

interface AuthFailedEvent {
    /** Undefined when the callback failed before we could tell which leg it was on. */
    mode: VercelAuthMode | undefined;
    /** The `error=` code the user is bounced to `/login` with. */
    reason: string;
}

/**
 * Emits the Vercel Marketplace lifecycle to PostHog.
 *
 * None of this goes through tRPC - Vercel calls these endpoints, or the browser
 * is mid-redirect - so without it the funnel starts at `onboarding.opened` and
 * everyone who fell out of the install/SSO chain before that is invisible.
 * `vercel.resource_created` in particular is the moment the customer's project
 * actually receives `AUTONOMA_SHARED_SECRET`, which every later step depends on.
 *
 * Nothing here throws: an analytics failure must not fail a Marketplace
 * callback, least of all the uninstall, which Vercel leaves stuck "pending" for
 * 24h if it does not finalize immediately.
 */
export class VercelAnalytics {
    private readonly logger: Logger;

    constructor(private readonly analytics: PostHogAnalytics = analyticsSingleton) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    resourceCreated(event: ResourceCreatedEvent): void {
        this.capture(event, VERCEL_EVENT.resourceCreated, {
            installationId: event.installationId,
            resourceId: event.resourceId,
            productId: event.productId,
            planId: event.planId,
            planName: event.planName,
        });
    }

    resourceProvisioningFailed(event: ResourceProvisioningFailedEvent): void {
        this.capture(event, VERCEL_EVENT.resourceProvisioningFailed, {
            installationId: event.installationId,
            resourceId: event.resourceId,
        });
    }

    resourceDeleted(event: ResourceDeletedEvent): void {
        this.capture(event, VERCEL_EVENT.resourceDeleted, {
            installationId: event.installationId,
            resourceId: event.resourceId,
        });
    }

    planChanged(event: PlanChangedEvent): void {
        this.capture(event, VERCEL_EVENT.planChanged, {
            installationId: event.installationId,
            planId: event.planId,
            planName: event.planName,
        });
    }

    installationDeleted(event: InstallationDeletedEvent): void {
        this.capture(event, VERCEL_EVENT.installationDeleted, {
            installationId: event.installationId,
            resourceCount: event.resourceCount,
            daysInstalled: event.daysInstalled,
        });
    }

    authCompleted(event: AuthCompletedEvent): void {
        this.capture(event, VERCEL_EVENT.authCompleted, { mode: event.mode });
    }

    /**
     * Attributed to no one: the callback failed before it resolved a user or an
     * org, which is exactly the case that is invisible today - the user is bounced
     * to `/login?error=vercel_auth_failed` and nothing records that it happened.
     */
    authFailed(event: AuthFailedEvent): void {
        this.emit(ANONYMOUS_DISTINCT_ID, VERCEL_EVENT.authFailed, undefined, {
            mode: event.mode,
            reason: event.reason,
            $process_person_profile: false,
        });
    }

    private capture(scope: OrgScope, event: string, properties: Record<string, unknown>): void {
        this.emit(scope.distinctId, event, scope.organizationId, {
            ...properties,
            organizationId: scope.organizationId,
        });
    }

    private emit(
        distinctId: string,
        event: string,
        organizationId: string | undefined,
        properties: Record<string, unknown>,
    ): void {
        try {
            this.analytics.capture(
                distinctId,
                event,
                properties,
                organizationId != null ? { [ORGANIZATION_GROUP]: organizationId } : undefined,
            );
        } catch (err) {
            this.logger.warn("Failed to capture Vercel marketplace event", { extra: { event }, err });
        }
    }
}
