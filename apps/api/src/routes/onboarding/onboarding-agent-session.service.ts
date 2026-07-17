import crypto from "node:crypto";
import { type $Enums, Prisma, type PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    type AgentLogEntry,
    type AgentLogEntryStatus,
    type OnboardingAgentEnvResolution,
    type OnboardingAgentPendingRequest,
    OnboardingAgentPendingRequestSchema,
} from "@autonoma/types";
import { z } from "zod";
import type { RateLimitPolicy, RateLimiterService } from "../../rate-limit/rate-limiter.service";

/**
 * Idle window before the UI treats the agent as released (soft mutex handed back
 * to the human, form editable). The agent re-claims on its next write, or the
 * window elapses again. The only "lock timeout": no background job, staleness is
 * derived from `agentLastActivityAt` at read time.
 */
const STALE_AFTER_MS = 30 * 60 * 1000;

/** How long a pairing code the UI shows the user stays valid. Single-use regardless. */
const PAIRING_TTL_MS = 15 * 60 * 1000;

const PAIRING_CODE_LENGTH = 8;
/** Unambiguous alphabet (no 0/O/1/I/L) - the user reads this off the screen and types it to the agent. */
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_MAX_ATTEMPTS = 5;

/** Cap the agent activity stream retained on the row (onboarding is short; trims oldest). */
const MAX_LOG_ENTRIES = 200;

/** Cap on the stored MCP client name - it is client-reported, so bound it defensively. */
const MAX_AGENT_CLIENT_LENGTH = 100;

/**
 * Pairing rate limits. Pairing is already gated by OAuth + org membership (a
 * guessed code can't reach an app you don't already have access to), so these are
 * defense-in-depth against hammering: brute-force pacing on the guess surface
 * (`pairAgent`, per user) and abuse of code minting (`createPairing`, per app).
 */
const PAIR_RATE_LIMIT: RateLimitPolicy = { max: 10, windowMs: 60_000 };
const PAIR_CREATE_RATE_LIMIT: RateLimitPolicy = { max: 30, windowMs: 60_000 };

/** Outcome of an agent's attempt to hold the config for a write. */
export type ClaimResult = { claimed: true } | { claimed: false; reason: "paused_by_user" };

export interface AgentSessionView {
    applicationId: string;
    step: $Enums.OnboardingStep;
    previewVerificationStatus: $Enums.OnboardingPreviewVerificationStatus;
    holder: $Enums.OnboardingAgentHolder;
    /**
     * Who effectively holds the config right now: `holder`, unless the agent held
     * it but has been idle past {@link STALE_AFTER_MS}, in which case control is
     * treated as released to the human (UI editable). Derived, never persisted.
     */
    effectiveHolder: $Enums.OnboardingAgentHolder;
    /** True when the agent held the config but went idle (derived release). */
    stale: boolean;
    agentConnectedAt?: Date;
    agentLastActivityAt?: Date;
    pendingRequest?: OnboardingAgentPendingRequest;
    /**
     * How the human answered the LAST env request when they skipped keys: the
     * agent must adapt to `skippedKeys` (default, drop, or rework the config)
     * instead of assuming every requested value exists. Cleared by the next
     * pending request; absent when the last answer set every key.
     */
    lastEnvResolution?: OnboardingAgentEnvResolution & { appName: string };
    logs: AgentLogEntry[];
    /** Which coding agent is driving (from MCP clientInfo); undefined when unknown. */
    agentClient?: string;
}

/**
 * Owns the agent-control axis of {@link OnboardingState}: the coordination point
 * between a coding agent (driving the onboarding MCP) and the UI watching it.
 * There is exactly one onboarding-state row per Application; `agentHolder` is a
 * soft mutex and `agentLastActivityAt` a heartbeat - no Redis, no reaper. This
 * axis is orthogonal to `step` / `previewVerificationStatus` (owned by the
 * onboarding/preview-readiness flow) and only governs who may write and what the
 * agent is blocked on.
 *
 * Pairing (OTP): the UI mints a short-lived code from its authenticated context
 * (org already known) via {@link createPairing}; the agent presents it to {@link
 * pairAgent}, which resolves the app + org and claims for the agent. So the app
 * identity is a stable id fixed in the UI - never a mutable repo name reverse-
 * resolved from an agent-supplied value.
 *
 * Secret VALUES never pass through here - only the KEYS an agent asks for, via
 * {@link raisePendingRequest}.
 */
export class OnboardingAgentSessionService {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        private readonly rateLimiter: RateLimiterService,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    /**
     * Mints a single-use pairing code for this app (org already fixed by the
     * caller's authenticated UI context) and stores it on the onboarding state.
     * The UI shows it next to the generic install command; the user hands it to
     * the agent.
     */
    async createPairing(applicationId: string, organizationId: string): Promise<{ code: string; expiresAt: Date }> {
        this.logger.info("Minting agent pairing code", { applicationId, organizationId });
        await this.rateLimiter.consume(
            `onboarding-pair-create:${applicationId}`,
            PAIR_CREATE_RATE_LIMIT,
            "Too many pairing-code requests; wait a minute and try again.",
        );
        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { id: true },
        });
        if (app == null) throw new NotFoundError("Application not found");

        const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
        for (let attempt = 0; attempt < PAIRING_CODE_MAX_ATTEMPTS; attempt++) {
            const code = generatePairingCode();
            try {
                await this.db.onboardingState.upsert({
                    where: { applicationId },
                    create: { applicationId, agentPairingCode: code, agentPairingExpiresAt: expiresAt },
                    update: { agentPairingCode: code, agentPairingExpiresAt: expiresAt },
                });
                return { code, expiresAt };
            } catch (err) {
                if (isUniqueViolation(err)) {
                    this.logger.warn("Pairing code collision; retrying", { applicationId, extra: { attempt } });
                    continue;
                }
                throw err;
            }
        }
        throw new Error("Could not mint a unique pairing code");
    }

    /**
     * Resolves a pairing code the agent presented to the app + org it was minted
     * for, verifies the OAuth user is a member of that org, and claims the config
     * for the agent (consuming the code). Throws NotFoundError for an unknown,
     * expired, or non-member code - all indistinguishable, so a code can't probe.
     */
    async pairAgent(code: string, userId: string): Promise<AgentSessionView> {
        this.logger.info("Agent pairing with code");
        // Per-user pacing on the guess surface. The real boundary is the org
        // membership check below - a guessed code can't reach an app the caller
        // isn't already a member of - so this is throttling, not the gate.
        await this.rateLimiter.consume(
            `onboarding-pair:${userId}`,
            PAIR_RATE_LIMIT,
            "Too many pairing attempts; wait a minute and try again.",
        );
        const state = await this.db.onboardingState.findFirst({
            where: { agentPairingCode: code },
            select: {
                applicationId: true,
                agentPairingExpiresAt: true,
                application: { select: { organizationId: true } },
            },
        });

        const expiresAt = state?.agentPairingExpiresAt;
        const organizationId = state?.application.organizationId;
        if (state == null || organizationId == null || expiresAt == null || expiresAt.getTime() < Date.now()) {
            throw new NotFoundError("Pairing code is invalid or expired");
        }

        const membership = await this.db.member.findFirst({
            where: { userId, organizationId },
            select: { organizationId: true },
        });
        if (membership == null) {
            this.logger.warn("Pairing user is not a member of the app's org", {
                userId,
                applicationId: state.applicationId,
                organizationId,
            });
            throw new NotFoundError("Pairing code is invalid or expired");
        }

        const now = new Date();
        // Consume the code atomically: the `agentPairingCode` in the WHERE means
        // only the first of two concurrent calls with the same leaked code matches
        // (the second sees it already nulled), enforcing single-use.
        const consumed = await this.db.onboardingState.updateMany({
            where: { applicationId: state.applicationId, agentPairingCode: code },
            data: {
                agentHolder: "agent",
                agentConnectedAt: now,
                agentLastActivityAt: now,
                agentPairingCode: null,
                agentPairingExpiresAt: null,
            },
        });
        if (consumed.count === 0) {
            throw new NotFoundError("Pairing code is invalid or expired");
        }
        this.logger.info("Agent paired and holding config", { applicationId: state.applicationId, organizationId });
        return this.requireView(state.applicationId);
    }

    /**
     * Resolves the org a paired agent's per-call `applicationId` acts in and
     * verifies the OAuth user is a member - the same boundary as pairing, applied
     * to every subsequent stateless tool call (the MCP server is stateless, so
     * the app is named per call). Probe-safe: an unknown app and a non-member both
     * throw the same NotFoundError.
     */
    async resolveOrgForMember(applicationId: string, userId: string): Promise<string> {
        // One relation-filtered query on the hot path (every tool call): the app must
        // exist, be enabled, AND have the OAuth user as a member of its org. Unknown
        // app and non-member both resolve to null, so the caller can't probe which.
        const application = await this.db.application.findFirst({
            where: { id: applicationId, disabled: false, organization: { members: { some: { userId } } } },
            select: { organizationId: true },
        });
        if (application == null) {
            this.logger.warn("No enabled app the agent user is a member of", { userId, applicationId });
            throw new NotFoundError(`No application found for ${applicationId}`);
        }
        return application.organizationId;
    }

    /**
     * Ensures the agent still holds the config before a write, refreshing the
     * heartbeat. Returns `paused_by_user` WITHOUT mutating when the human has
     * explicitly taken over (Stop), so the caller stands down. An idle release
     * leaves `agentHolder = agent`, so the agent reclaims it here transparently.
     */
    async claimForAgent(applicationId: string): Promise<ClaimResult> {
        return this.db.$transaction(async (tx) => {
            // Lock the row before reading the holder: this decides who controls the
            // config, so a concurrent stopForHuman (the user's Stop) must not slip
            // between the read and the write and get silently overwritten.
            await this.lockRow(tx, applicationId);
            const state = await tx.onboardingState.findUnique({
                where: { applicationId },
                select: { agentHolder: true },
            });
            if (state == null) throw new NotFoundError("Onboarding state not found");
            if (state.agentHolder === "human") {
                this.logger.info("Config is held by the human; agent standing down", { applicationId });
                return { claimed: false, reason: "paused_by_user" };
            }
            await tx.onboardingState.update({
                where: { applicationId },
                data: { agentHolder: "agent", agentLastActivityAt: new Date() },
            });
            return { claimed: true };
        });
    }

    /** Refreshes the heartbeat only while the agent holds the config (for read-only agent polling). */
    async heartbeatIfAgentHeld(applicationId: string): Promise<void> {
        await this.db.onboardingState.updateMany({
            where: { applicationId, agentHolder: "agent" },
            data: { agentLastActivityAt: new Date() },
        });
    }

    /**
     * The human took over (Stop / Take over): hand the mutex back and pause the
     * agent. UI-invoked, so scoped to the caller's org.
     */
    async stopForHuman(applicationId: string, organizationId: string): Promise<void> {
        this.logger.info("Human taking over onboarding config", { applicationId, organizationId });
        await this.assertAppInOrg(applicationId, organizationId);
        // Do NOT touch agentLastActivityAt: a paused session must not read as active.
        await this.db.onboardingState.updateMany({
            where: { applicationId },
            data: { agentHolder: "human" },
        });
    }

    /**
     * Hand control back to the agent (Resume with Claude): flip the mutex and
     * refresh the heartbeat. UI-invoked, so scoped to the caller's org.
     */
    async resumeForAgent(applicationId: string, organizationId: string): Promise<void> {
        this.logger.info("Handing onboarding config back to the agent", { applicationId, organizationId });
        await this.assertAppInOrg(applicationId, organizationId);
        await this.db.onboardingState.updateMany({
            where: { applicationId },
            data: { agentHolder: "agent", agentLastActivityAt: new Date() },
        });
    }

    /**
     * Raises a question only the human can answer (env values, or a choice) and
     * pauses the agent's progress; the agent discovers the resolution by polling.
     * An env request stores only the KEYS - values are entered in the UI.
     */
    async raisePendingRequest(applicationId: string, request: OnboardingAgentPendingRequest): Promise<void> {
        this.logger.info("Raising pending request for human", { applicationId, extra: { kind: request.kind } });
        await this.db.onboardingState.update({
            where: { applicationId },
            data: { agentPendingRequest: request, agentLastActivityAt: new Date() },
        });
    }

    /**
     * Resolves a pending request the human answered in the UI. A fully-set env
     * answer (or a non-env request) clears the column, matching the agent's
     * "cleared = all values set" contract. An answer WITH skipped keys instead
     * writes a resolution back onto the stored request - same column, no
     * migration - which {@link getForUi} surfaces as `lastEnvResolution` so the
     * polling agent learns which keys it must live without. The set keys are
     * derived here from the stored request (requested minus skipped) - the
     * request is the single source of truth for what was asked. Org-scoped.
     */
    async resolvePendingRequest(applicationId: string, organizationId: string, skippedKeys?: string[]): Promise<void> {
        this.logger.info("Clearing resolved pending request", {
            applicationId,
            organizationId,
            extra: { skippedKeys },
        });
        await this.assertAppInOrg(applicationId, organizationId);

        if (skippedKeys != null && skippedKeys.length > 0) {
            const state = await this.db.onboardingState.findUnique({
                where: { applicationId },
                select: { agentPendingRequest: true },
            });
            const request = this.parsePendingRequest(state?.agentPendingRequest ?? null);
            if (request?.kind === "env") {
                const skipped = new Set(skippedKeys);
                const resolution: OnboardingAgentEnvResolution = {
                    setKeys: request.keys.filter((key) => !skipped.has(key)),
                    skippedKeys: request.keys.filter((key) => skipped.has(key)),
                };
                await this.db.onboardingState.update({
                    where: { applicationId },
                    data: { agentPendingRequest: { ...request, resolution }, agentLastActivityAt: new Date() },
                });
                return;
            }
        }

        await this.db.onboardingState.update({
            where: { applicationId },
            data: { agentPendingRequest: Prisma.JsonNull, agentLastActivityAt: new Date() },
        });
    }

    /**
     * Appends a tool-call entry to the agent activity stream (a `running` row the
     * UI renders with a spinner) and returns its id so {@link finishLogEntry} can
     * mark it done. `toolArguments` is rendered as dim JSON and never carries
     * secret values.
     */
    async startLogEntry(
        applicationId: string,
        tool: string,
        message: string,
        toolArguments?: AgentLogEntry["toolArguments"],
    ): Promise<string> {
        const entry: AgentLogEntry = {
            id: crypto.randomUUID(),
            message,
            timestamp: new Date().toISOString(),
            tool,
            toolArguments,
            status: "running",
        };
        await this.appendEntry(applicationId, entry);
        return entry.id;
    }

    /** Marks a tool-call entry done (or failed, with the error for the red row). */
    async finishLogEntry(
        applicationId: string,
        entryId: string,
        status: Exclude<AgentLogEntryStatus, "running">,
        error?: string,
    ): Promise<void> {
        await this.db.$transaction(async (tx) => {
            await this.lockRow(tx, applicationId);
            const state = await tx.onboardingState.findUnique({
                where: { applicationId },
                select: { agentLogs: true },
            });
            if (state == null) return;
            const logs = state.agentLogs.map((entry) => (entry.id === entryId ? { ...entry, status, error } : entry));
            await tx.onboardingState.update({ where: { applicationId }, data: { agentLogs: logs } });
        });
    }

    /**
     * The UI poll: the onboarding state's agent-control fields plus the derived
     * `effectiveHolder` / `stale` (so the form knows whether to lock) and the
     * activity stream. Returns undefined when the app has no onboarding state.
     */
    async getForUi(applicationId: string): Promise<AgentSessionView | undefined> {
        const state = await this.db.onboardingState.findUnique({
            where: { applicationId },
            select: {
                step: true,
                previewVerificationStatus: true,
                agentHolder: true,
                agentConnectedAt: true,
                agentLastActivityAt: true,
                agentPendingRequest: true,
                agentLogs: true,
                agentClient: true,
            },
        });
        if (state == null) return undefined;

        const stale = state.agentHolder === "agent" && this.isStale(state.agentLastActivityAt);
        // A request carrying a resolution was already answered (with skips): it is
        // no longer pending - it rides the same column purely to carry the skip
        // outcome to the polling agent.
        const request = this.parsePendingRequest(state.agentPendingRequest);
        const lastEnvResolution =
            request?.kind === "env" && request.resolution != null
                ? {
                      appName: request.appName,
                      setKeys: request.resolution.setKeys,
                      skippedKeys: request.resolution.skippedKeys,
                  }
                : undefined;
        return {
            applicationId,
            step: state.step,
            previewVerificationStatus: state.previewVerificationStatus,
            holder: state.agentHolder,
            effectiveHolder: stale ? "human" : state.agentHolder,
            stale,
            agentConnectedAt: state.agentConnectedAt ?? undefined,
            agentLastActivityAt: state.agentLastActivityAt ?? undefined,
            pendingRequest: lastEnvResolution == null ? request : undefined,
            lastEnvResolution,
            logs: state.agentLogs,
            agentClient: state.agentClient ?? undefined,
        };
    }

    /**
     * Best-effort record of which coding agent is driving, from the MCP `clientInfo`
     * handshake. Only fills the column while it is empty (first known client wins),
     * so it is a cheap no-op on every subsequent call and never overwrites.
     */
    async recordAgentClient(applicationId: string, client: string): Promise<void> {
        const trimmed = client.trim();
        if (trimmed.length === 0) return;
        await this.db.onboardingState.updateMany({
            where: { applicationId, agentClient: null },
            data: { agentClient: trimmed.slice(0, MAX_AGENT_CLIENT_LENGTH) },
        });
    }

    private async requireView(applicationId: string): Promise<AgentSessionView> {
        const view = await this.getForUi(applicationId);
        if (view == null) throw new NotFoundError("Onboarding state not found");
        return view;
    }

    /**
     * Row-lock the onboarding_state row for the rest of the transaction so
     * concurrent read-modify-writes of the `agentLogs` JSON array serialize instead
     * of clobbering each other (lost update under READ COMMITTED). A missing row
     * locks nothing; callers handle the null state that follows.
     */
    private async lockRow(tx: Prisma.TransactionClient, applicationId: string): Promise<void> {
        await tx.$queryRaw`SELECT 1 FROM onboarding_state WHERE application_id = ${applicationId} FOR UPDATE`;
    }

    private async appendEntry(applicationId: string, entry: AgentLogEntry): Promise<void> {
        await this.db.$transaction(async (tx) => {
            await this.lockRow(tx, applicationId);
            const state = await tx.onboardingState.findUnique({
                where: { applicationId },
                select: { agentLogs: true },
            });
            if (state == null) throw new NotFoundError("Onboarding state not found");
            const logs = [...state.agentLogs, entry].slice(-MAX_LOG_ENTRIES);
            await tx.onboardingState.update({
                where: { applicationId },
                data: { agentLogs: logs, agentLastActivityAt: new Date() },
            });
        });
    }

    /** Verify the app belongs to the caller's org (authorization for UI-invoked mutations). */
    private async assertAppInOrg(applicationId: string, organizationId: string): Promise<void> {
        const app = await this.db.application.findFirst({
            where: { id: applicationId, organizationId },
            select: { id: true },
        });
        if (app == null) throw new NotFoundError("Application not found");
    }

    private isStale(lastActivityAt: Date | null): boolean {
        if (lastActivityAt == null) return true;
        return Date.now() - lastActivityAt.getTime() > STALE_AFTER_MS;
    }

    /** Validate the stored request at the boundary; a malformed one degrades to "nothing pending". */
    private parsePendingRequest(
        stored: OnboardingAgentPendingRequest | null,
    ): OnboardingAgentPendingRequest | undefined {
        if (stored == null) return undefined;
        const parsed = OnboardingAgentPendingRequestSchema.safeParse(stored);
        if (!parsed.success) {
            this.logger.warn("Stored agentPendingRequest did not validate; treating as none", {
                extra: { error: z.prettifyError(parsed.error) },
            });
            return undefined;
        }
        return parsed.data;
    }
}

/** A pairing code from the unambiguous alphabet. */
function generatePairingCode(): string {
    let code = "";
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
        code += PAIRING_CODE_ALPHABET[crypto.randomInt(PAIRING_CODE_ALPHABET.length)];
    }
    return code;
}

/** Whether a thrown Prisma error is a unique-constraint violation (P2002). */
function isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
