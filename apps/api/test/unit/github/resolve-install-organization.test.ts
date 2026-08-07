import { describe, expect, it, vi } from "vitest";

const MOCK_SECRET = "test-secret-for-hmac-signing";

// Set env before importing the module under test - it signs with this at import time.
process.env.BETTER_AUTH_SECRET = MOCK_SECRET;

import { createInstallState } from "../../../src/github/github-state";
import { resolveInstallOrganization } from "../../../src/github/resolve-install-organization";

/** No installation is on record - the state of the world an attacker probing ids would find. */
const noOwner = () => Promise.resolve(undefined);

describe("resolveInstallOrganization", () => {
    it("attributes to the organization the signed state was minted for", async () => {
        const state = await createInstallState("org-123", "/app/acme-web/github");

        await expect(resolveInstallOrganization(state, 4242, noOwner)).resolves.toEqual({
            organizationId: "org-123",
            returnPath: "/app/acme-web/github",
            via: "state",
        });
    });

    it("attributes an installation already on record to its existing owner", async () => {
        const findOwner = vi.fn().mockResolvedValue("org-owner");

        await expect(resolveInstallOrganization(undefined, 4242, findOwner)).resolves.toEqual({
            organizationId: "org-owner",
            via: "installation-owner",
        });
        expect(findOwner).toHaveBeenCalledWith(4242);
    });

    /**
     * `via` is what lets the caller treat the two sources differently. State is proof we started
     * the flow; an owner lookup is only "this id is on record", which anyone guessing ids can also
     * trigger.
     */
    it("reports how the attribution was reached", async () => {
        const fromState = await resolveInstallOrganization(await createInstallState("org-1"), 1, noOwner);
        const fromOwner = await resolveInstallOrganization(undefined, 1, () => Promise.resolve("org-2"));

        expect(fromState.via).toBe("state");
        expect(fromOwner.via).toBe("installation-owner");
    });

    /**
     * The security property this module exists for. `/v1/github/callback` is unauthenticated and
     * `installation_id` is a query parameter, so an unrecognised id must attribute to NOTHING -
     * never to whoever happens to be signed in. Falling back to the session here would let someone
     * walk the (small, sequential) id space and attach an installation they do not own to their
     * own workspace, gaining read access to another organization's repositories.
     */
    it("refuses to attribute an unrecognised installation id", async () => {
        await expect(resolveInstallOrganization(undefined, 999_999, noOwner)).resolves.toEqual({});
    });

    it("refuses to attribute when the state does not verify and the id is unrecognised", async () => {
        const forged = `${Buffer.from(
            JSON.stringify({ organizationId: "attacker", exp: Date.now() + 60_000 }),
        ).toString("base64url")}.deadbeef`;

        await expect(resolveInstallOrganization(forged, 999_999, noOwner)).resolves.toEqual({});
    });

    it("refuses to attribute an expired state, rather than falling through to anything weaker", async () => {
        vi.useFakeTimers();
        const state = await createInstallState("org-123");
        vi.advanceTimersByTime(16 * 60 * 1000);

        await expect(resolveInstallOrganization(state, 999_999, noOwner)).resolves.toEqual({});

        vi.useRealTimers();
    });

    /**
     * The replay this module does NOT stop, asserted so nobody mistakes it for handled.
     *
     * State proves only which organization asked to install - it cannot name the installation,
     * because it is minted before the installation exists. So a valid state for the attacker's own
     * organization, presented with an installation id that is NOT on record, resolves to the
     * attacker. What stops the bind is downstream, in `handleInstallation`: the installation has to
     * have been created moments ago (FRESH_INSTALL_WINDOW_MS), and the unique index catches ids
     * another organization already holds.
     *
     * If this test starts failing because attribution refuses, that is an improvement - but the
     * defence has to move somewhere, not just disappear.
     */
    it("still attributes valid state to its organization even for an unknown installation id", async () => {
        const state = await createInstallState("attacker-org");

        await expect(resolveInstallOrganization(state, 999_999, noOwner)).resolves.toEqual({
            organizationId: "attacker-org",
            returnPath: undefined,
            via: "state",
        });
    });

    /**
     * A forged request naming a real installation resolves to the organization that ALREADY owns
     * it - not to the caller - so the attacker gains nothing and the owner's row is at most
     * refreshed in place.
     */
    it("cannot be used to move an installation to another organization", async () => {
        const state = await createInstallState("attacker-org");
        const findOwner = vi.fn().mockResolvedValue("victim-org");

        // With valid state the state wins, so the attacker's own organization is what a state-
        // carrying forgery attributes to - which is why `handleInstallation` must ALSO refuse to
        // repoint an installation that another organization already holds (its unique constraint).
        await expect(resolveInstallOrganization(state, 4242, findOwner)).resolves.toEqual({
            organizationId: "attacker-org",
            returnPath: undefined,
            via: "state",
        });

        // Without state, it resolves to the owner - never the caller.
        await expect(resolveInstallOrganization(undefined, 4242, findOwner)).resolves.toEqual({
            organizationId: "victim-org",
            via: "installation-owner",
        });
    });
});
