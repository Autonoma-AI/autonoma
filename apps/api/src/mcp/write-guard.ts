import type { OnboardingPreviewEnvironmentMode } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { AgentLogEntry } from "@autonoma/types";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Services } from "../routes/build-services";
import { recipeConflictResult } from "./recipe-conflict-result";
import { resolveVercelState } from "./resolve-vercel-state";
import { describeError, jsonResult, toToolResult } from "./tool-result";
import { isVercelPath } from "./vercel-onboarding-guidance";
import { wrongPathResult } from "./wrong-path-result";

/** Identifies one write to the guard: what to call it on the activity feed, and where it applies. */
export interface GuardedWrite {
    applicationId: string;
    /** Already resolved by the caller, so the guard never has to look it up again. */
    organizationId: string;
    tool: string;
    message: string;
    /** Rendered on the activity row when the write is being watched; never carries secret values. */
    toolArguments?: AgentLogEntry["toolArguments"];
    /**
     * Refuse the write when the application gets its previews the other way, naming the tool to
     * use instead. A property of the TOOL - config only means something for previews Autonoma
     * builds - so it is declared where the tool is, not decided here.
     */
    requires?: {
        source: OnboardingPreviewEnvironmentMode;
        useInstead: string;
        /**
         * Redirect to use when the app turns out to be on Vercel. Without it a previewkit-only
         * tool sends every customer-pipeline app to the webhook tools - and `get_signal_setup`
         * refuses a linked Vercel project, so the agent is bounced between two tools that each
         * point at the other.
         */
        useInsteadOnVercel?: string;
    };
}

/** Runs one write with whatever protection the application it touches calls for. */
export type WriteGuard = <T>(
    write: GuardedWrite,
    work: (organizationId: string) => Promise<T>,
) => Promise<CallToolResult>;

/** The result a write returns when the human has taken over - the agent must stand down. */
function pausedResult(): CallToolResult {
    return jsonResult({
        status: "paused",
        standDown: true,
        message:
            "The user took over configuration in the Autonoma UI. Stop configuring and let them continue. " +
            "They can hand control back with 'Resume with Claude', after which your next call re-claims it.",
    });
}

/**
 * The one guard every MCP write runs under, whichever mount it arrived on.
 *
 * It decides per call whether the write has to serialize with a human, and it decides from the
 * APPLICATION's situation: an application an agent is driving through onboarding has a user
 * watching a read-only config screen, so the write takes the soft mutex (standing down if that
 * user took over) and streams itself onto the activity feed they are watching. An application
 * nobody is configuring - the long-live app whose pull request someone is debugging from their
 * editor - has no mutex to take and no feed to write to, so the work just runs.
 *
 * The `requires` path check is not part of that decision and runs either way: saving a preview
 * config means nothing for an app whose own pipeline builds its previews, whoever is writing it.
 */
export function createWriteGuard(services: Services): WriteGuard {
    const logger = rootLogger.child({ name: "mcpWriteGuard" });
    const session = services.onboardingAgentSession;

    return async ({ applicationId, organizationId, tool, message, toolArguments, requires }, work) => {
        try {
            if (requires != null) {
                const mode = await services.onboarding.getPreviewEnvironmentMode(applicationId, organizationId);
                // Unset means the user has not chosen yet - let it through rather than block an
                // agent on a path that is still undecided.
                if (mode != null && mode !== requires.source) {
                    // Only on the refusal path, so the happy path pays nothing for it.
                    const vercelRedirect = requires.useInsteadOnVercel;
                    const useInstead =
                        vercelRedirect != null &&
                        isVercelPath(await resolveVercelState(services, applicationId, organizationId))
                            ? vercelRedirect
                            : requires.useInstead;
                    return wrongPathResult(tool, requires.source, useInstead);
                }
            }

            if (!(await session.isAgentDriven(applicationId))) {
                logger.info("Running write without the config mutex", { applicationId, extra: { tool } });
                return jsonResult(await work(organizationId));
            }

            const claim = await session.claimForAgent(applicationId);
            if (!claim.claimed) return pausedResult();

            const eventId = await session.startLogEntry(applicationId, tool, message, toolArguments);
            try {
                const result = await work(organizationId);
                await session.finishLogEntry(applicationId, eventId, "done");
                return jsonResult(result);
            } catch (err) {
                await session.finishLogEntry(applicationId, eventId, "error", describeError(err));
                throw err;
            }
        } catch (err) {
            logger.warn(`${tool} failed`, { applicationId, err });
            // A losing recipe race is not a failure the agent should give up on - hand back the
            // merge inputs instead of an error string. Undefined for anything else.
            return recipeConflictResult(err) ?? toToolResult(err);
        }
    };
}
