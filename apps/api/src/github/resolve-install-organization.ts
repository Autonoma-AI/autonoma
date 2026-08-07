import { logger as rootLogger } from "@autonoma/logger";
import { verifyInstallState } from "./github-state";

/** Which organization an install callback belongs to, and where to send the browser afterwards. */
export interface InstallAttribution {
    /** Undefined when the callback could not be attributed. Callers must NOT guess. */
    organizationId?: string;
    returnPath?: string;
    /**
     * How the attribution was reached. `state` is proof we started this flow for that
     * organization; `installation-owner` is only "this id is already on record", which an
     * unauthenticated caller can also trigger by guessing the id - so it must not be treated as
     * permission to change anything that is not already true.
     */
    via?: "state" | "installation-owner";
}

/**
 * Decides which organization an install callback belongs to.
 *
 * This is a security boundary, not a convenience lookup. `/v1/github/callback` is unauthenticated
 * and `installation_id` is a plain query parameter, so nothing in the request proves GitHub sent
 * it - anyone can issue the same GET with any installation id. Attribution may therefore only come
 * from something WE established:
 *
 * 1. the signed state we minted for a specific organization (the only source carrying a
 *    returnPath), or
 * 2. the installation's existing owner, for an installation already on record - which resolves to
 *    whoever already owns it, so a forged request can at most refresh a row in place for an
 *    organization the caller gains nothing from. This is the `setup_action=update` path, where
 *    GitHub sends no state.
 *
 * There is deliberately NO fallback to the caller's session. Binding an unauthenticated
 * `installation_id` to "whoever is signed in" would let someone walk the (small, sequential) id
 * space and attach an installation they do not own to their own workspace, gaining read access to
 * another organization's repositories.
 */
export async function resolveInstallOrganization(
    state: string | undefined,
    installationId: number,
    findOwner: (installationId: number) => Promise<string | undefined>,
): Promise<InstallAttribution> {
    const logger = rootLogger.child({ name: "resolveInstallOrganization" });

    // Valid state names an ORGANIZATION, never an installation - it is minted before the
    // installation exists, so it cannot be bound to one. That means a valid state for your own
    // organization presented with someone else's `installation_id` resolves here to your
    // organization. This function is deliberately not where that is stopped: the bind is, in
    // `handleInstallation`, which requires the installation to have been created moments ago
    // (FRESH_INSTALL_WINDOW_MS) and leans on the unique index for ids another organization holds.
    // If you are here because you spotted the replay - that is the defence, and it lives there
    // because this layer has nothing to check it against.
    const statePayload = state != null ? await verifyInstallState(state) : undefined;
    if (statePayload != null) {
        return { organizationId: statePayload.organizationId, returnPath: statePayload.returnPath, via: "state" };
    }

    if (state != null) {
        // Present but did not verify: expired, tampered, or signed with another secret.
        logger.warn("GitHub install callback carried state that did not verify", { extra: { installationId } });
    }

    const organizationId = await findOwner(installationId);
    return organizationId != null ? { organizationId, via: "installation-owner" } : {};
}
