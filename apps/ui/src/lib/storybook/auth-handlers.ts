import { HttpResponse, http } from "msw";
import type { OrganizationFixture, SessionFixture } from "./auth-fixtures";

interface AuthHandlerFixtures {
    /** Omit to render as logged-out - better-auth returns null, not an error. */
    session?: SessionFixture;
    organizations?: OrganizationFixture[];
}

/**
 * MSW handlers for the better-auth endpoints (`/v1/auth/*`) the UI reads
 * while rendering. Unrecognized auth endpoints get an empty 200 so stray
 * client calls never hang a story.
 */
export function authHandlers(fixtures: AuthHandlerFixtures) {
    return [
        http.get("*/v1/auth/get-session", () => HttpResponse.json(fixtures.session ?? null)),
        http.get("*/v1/auth/organization/list", () => HttpResponse.json(fixtures.organizations ?? [])),
        http.all("*/v1/auth/*", () => HttpResponse.json({})),
    ];
}
