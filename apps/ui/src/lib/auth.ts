import { apiKeyClient } from "@better-auth/api-key/client";
import { useRouteContext } from "@tanstack/react-router";
import { inferAdditionalFields, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { env } from "env";
import { useSession } from "lib/query/auth.queries";

function getBaseURL() {
    const host = window.location.hostname;
    const internalDomain = env.VITE_INTERNAL_DOMAIN;
    if (host.endsWith(`.preview.${internalDomain}`)) {
        return env.VITE_API_URL;
    }
    if (host.startsWith("alpha-") || host.endsWith(`.alpha.${internalDomain}`)) {
        return `https://beta.api.${internalDomain}`;
    }
    return undefined;
}

export const authClient = createAuthClient({
    baseURL: getBaseURL(),
    basePath: "/v1/auth",
    plugins: [
        organizationClient(),
        apiKeyClient(),
        inferAdditionalFields({
            user: {
                role: {
                    type: "string",
                },
            },
        }),
    ],
});

/** Access the auth client, from any route */
export function useAuthClient() {
    // Read the context from the root route.
    return useRouteContext({ from: "__root__", select: (ctx) => ctx.auth });
}

/** Access commonly used auth data */
export function useAuth() {
    const authClient = useAuthClient();
    const session = useSession();

    // This allows type narrowing on isAuthenticated checks.
    if (session.data == null || session.data.user == null)
        return {
            authClient,
            session,
            user: null,
            isAuthenticated: false,
            isAdmin: false,
            activeOrganizationId: null,
        } as const;

    return {
        authClient,
        session,
        user: session.data.user,
        isAuthenticated: true,
        isAdmin: session.data.user.role === "admin",
        activeOrganizationId: session.data.session.activeOrganizationId,
    } as const;
}
