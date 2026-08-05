import crypto from "node:crypto";
import { type $Enums, Prisma, type PrismaClient } from "@autonoma/db";
import { BadRequestError, NotFoundError } from "@autonoma/errors";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    type AgentLogEntry,
    type AgentLogEntryStatus,
    type OnboardingAgentEnvResolution,
    type OnboardingAgentPendingRequest,
    OnboardingAgentPendingRequestSchema,
} from "@autonoma/types";
import { z } from "zod";
import type { McpPrincipal } from "../../mcp/mcp-principal";
import type { RateLimitPolicy, RateLimiterService } from "../../rate-limit/rate-limiter.service";
import { isAgentDrivenApplication, isAgentSessionStale } from "./agent-session-liveness";
import { assertApplicationInOrg } from "./assert-application-in-org";

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

/**
 * The one thing every rejected pairing says, whatever the cause - unknown code,
 * already spent, expired, an app the caller cannot reach, an app that has since been
 * deleted. Identical text for all of them is what stops a code being used to probe.
 *
 * It is written at the agent rather than at a log reader: the recoverable case is
 * overwhelmingly an agent replaying a code from earlier in its own context, so the
 * message has to say that reuse is never the answer and name the one action that is
 * (ask for the code on screen now). The last line matters as much as the rest - an
 * agent that shrugs this off and configures an app it happens to know the name of is
 * the failure this whole exchange exists to prevent.
 */
const PAIRING_REJECTED_MESSAGE =
    "Pairing code rejected. A pairing code is single-use and short-lived, and it stops working " +
    "when the app it was minted for is deleted or a newer code is shown - so an earlier code from " +
    "this conversation will never pair, and retrying it will not help. Ask the user for the code " +
    'CURRENTLY on their Autonoma screen (reopening "Configure with coding agent" shows a fresh ' +
    "one) and call pair again with that. Do not configure any app until a pair succeeds.";

/** Outcome of an agent's attempt to hold the config for a write. */
export type ClaimResult = { claimed: true } | { claimed: false; reason: "paused_by_user" };

export interface AgentSessionView {
    applicationId: string;
    step: $Enums.OnboardingStep;
    /**
     * Which preview path the app is on. Null until the user picks one. A paired
     * agent needs it to know which playbook applies: PreviewKit apps are
     * configured and deployed through the MCP, whereas `existing_deploys` apps
     * deploy on the customer's own pipeline and only signal Autonoma.
     */
    previewEnvironmentMode?: $Enums.OnboardingPreviewEnvironmentMode;
    previewVerificationStatus: $Enums.OnboardingPreviewVerificationStatus;
    holder: $Enums.OnboardingAgentHolder;
    /**
     * Who effectively holds the config right now: `holder`, unless the agent held
     * it but has been idle past the staleness window, in which case control is
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
     *
     * Minting also revokes every other outstanding code in the organization, so the
     * only live code is the one currently on screen. Codes are stored per
     * application, so without this a user who abandons one app's onboarding and
     * starts another leaves the first app's code working: the screen shows one code
     * while an agent handed the older one pairs successfully with a different
     * application, and neither side can tell. Onboarding two apps side by side in one
     * org is the cost, and it costs one click - reopening the dialog re-mints.
     */
    async createPairing(applicationId: string, organizationId: string): Promise<{ code: string; expiresAt: Date }> {
        this.logger.info("Minting agent pairing code", { applicationId, organizationId });
        await this.rateLimiter.consume(
            `onboarding-pair-create:${applicationId}`,
            PAIR_CREATE_RATE_LIMIT,
            "Too many pairing-code requests; wait a minute and try again.",
        );
        await assertApplicationInOrg(this.db, applicationId, organizationId);

        const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
        for (let attempt = 0; attempt < PAIRING_CODE_MAX_ATTEMPTS; attempt++) {
            const code = generatePairingCode();
            try {
                // Mint and revoke commit together: half of this leaves the organization
                // either with two live codes or with none, and both are exactly the
                // confusion the revoke exists to remove. A collision rolls the whole
                // attempt back, so the retry below starts from an untouched state.
                await this.db.$transaction(async (tx) => {
                    await tx.onboardingState.upsert({
                        where: { applicationId },
                        create: { applicationId, agentPairingCode: code, agentPairingExpiresAt: expiresAt },
                        update: { agentPairingCode: code, agentPairingExpiresAt: expiresAt },
                    });
                    await this.revokeOtherCodesInOrg(tx, applicationId, organizationId);
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
     * for the agent (consuming the code). Throws BadRequestError carrying
     * {@link PAIRING_REJECTED_MESSAGE} for an unknown, spent, expired, non-member or
     * deleted-app code - all indistinguishable, so a code can't probe.
     */
    async pairAgent(code: string, principal: McpPrincipal): Promise<AgentSessionView> {
        this.logger.info("Agent pairing with code");
        // Per-user pacing on the guess surface. The real boundary is the organization
        // check below - a guessed code can't reach an app outside the principal's orgs -
        // so this is throttling, not the gate.
        await this.rateLimiter.consume(
            `onboarding-pair:${principal.userId}`,
            PAIR_RATE_LIMIT,
            "Too many pairing attempts; wait a minute and try again.",
        );
        // `disabled: false` is part of the lookup, not a check after it: a deleted
        // application keeps its onboarding row, so without this a code minted moments
        // before the delete still resolves - and pairing would flip a dead app to
        // agent-held before the tool failed further downstream on the same app.
        const state = await this.db.onboardingState.findFirst({
            where: { agentPairingCode: code, application: { disabled: false } },
            select: {
                applicationId: true,
                agentPairingExpiresAt: true,
                application: { select: { organizationId: true } },
            },
        });

        const expiresAt = state?.agentPairingExpiresAt;
        const organizationId = state?.application.organizationId;
        // The principal's organizations are the whole authorization boundary here: they are the
        // caller's memberships, already narrowed to one org when the credential is an API key and
        // already stripped of the read-only demo org (which the MCP path must never reach, since it
        // bypasses `writeProcedure`). Every rejection - unknown code, expired code, an app the
        // caller cannot reach - throws the same error, so a code can never be used to probe.
        if (
            state == null ||
            organizationId == null ||
            !principal.organizationIds.includes(organizationId) ||
            expiresAt == null ||
            expiresAt.getTime() < Date.now()
        ) {
            this.logger.warn("Rejected agent pairing", {
                userId: principal.userId,
                extra: { known: state != null, expired: expiresAt != null && expiresAt.getTime() < Date.now() },
            });
            throw new BadRequestError(PAIRING_REJECTED_MESSAGE);
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
            throw new BadRequestError(PAIRING_REJECTED_MESSAGE);
        }
        this.logger.info("Agent paired and holding config", { applicationId: state.applicationId, organizationId });
        return this.requireView(state.applicationId);
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

    /**
     * Whether an agent is driving this application's configuration right now -
     * the question an MCP write asks before deciding to take the soft mutex and
     * stream itself onto the activity feed. An application with no onboarding
     * state at all has no session, so it answers false rather than throwing.
     */
    async isAgentDriven(applicationId: string): Promise<boolean> {
        const state = await this.db.onboardingState.findUnique({
            where: { applicationId },
            select: { step: true, agentConnectedAt: true, agentLastActivityAt: true },
        });
        if (state == null) return false;
        const driven = isAgentDrivenApplication({
            step: state.step,
            agentConnectedAt: state.agentConnectedAt ?? undefined,
            agentLastActivityAt: state.agentLastActivityAt ?? undefined,
        });
        this.logger.info("Resolved agent-driven state", { applicationId, extra: { driven, step: state.step } });
        return driven;
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
        await assertApplicationInOrg(this.db, applicationId, organizationId);
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
        await assertApplicationInOrg(this.db, applicationId, organizationId);
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
        await assertApplicationInOrg(this.db, applicationId, organizationId);

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
    async getForUi(applicationId: string, organizationId: string): Promise<AgentSessionView | undefined> {
        await assertApplicationInOrg(this.db, applicationId, organizationId);
        return this.readView(applicationId);
    }

    /**
     * The view itself, unauthorized. Private on purpose: every caller either came
     * through {@link getForUi} or has already established the org (pairing, which
     * checked membership before it consumed the code).
     */
    private async readView(applicationId: string): Promise<AgentSessionView | undefined> {
        const state = await this.db.onboardingState.findUnique({
            where: { applicationId },
            select: {
                step: true,
                previewEnvironmentMode: true,
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

        const stale = state.agentHolder === "agent" && isAgentSessionStale(state.agentLastActivityAt ?? undefined);
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
            previewEnvironmentMode: state.previewEnvironmentMode ?? undefined,
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

    /**
     * Clear every outstanding pairing code in this organization except the app just
     * minted for, so the code on screen is the only one that pairs. Read first and
     * update by id: `updateMany` cannot filter through the `application` relation.
     * Runs on the caller's transaction, so the read and the write it decides cannot
     * be split by a concurrent mint for a sibling app.
     */
    private async revokeOtherCodesInOrg(
        tx: Prisma.TransactionClient,
        applicationId: string,
        organizationId: string,
    ): Promise<void> {
        const stale = await tx.onboardingState.findMany({
            where: {
                applicationId: { not: applicationId },
                agentPairingCode: { not: null },
                application: { organizationId },
            },
            select: { applicationId: true },
        });
        if (stale.length === 0) return;

        const { count } = await tx.onboardingState.updateMany({
            where: { applicationId: { in: stale.map((state) => state.applicationId) } },
            data: { agentPairingCode: null, agentPairingExpiresAt: null },
        });
        this.logger.info("Revoked pairing codes superseded by a newer one", {
            applicationId,
            organizationId,
            extra: { revoked: count },
        });
    }

    private async requireView(applicationId: string): Promise<AgentSessionView> {
        // Reads the view directly: the only caller is pairing, which has already
        // checked the principal's membership of this app's organization.
        const view = await this.readView(applicationId);
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
