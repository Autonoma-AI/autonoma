import type { AuthCookie } from "@autonoma/types";
import type { BrowserContext } from "playwright";

export type PlaywrightCookie = Parameters<BrowserContext["addCookies"]>[0][number];

function normalizeSameSite(sameSite: AuthCookie["sameSite"]): PlaywrightCookie["sameSite"] | undefined {
    if (sameSite == null) return undefined;
    const normalized = String(sameSite).trim().toLowerCase();
    if (normalized === "lax") return "Lax";
    if (normalized === "strict") return "Strict";
    if (normalized === "none") return "None";
    return undefined;
}

/**
 * Converts auth cookies from the scenario webhook into Playwright-compatible cookies.
 * Playwright's addCookies requires either `url` or both `domain` and `path` on each cookie.
 * If the webhook cookie has neither, the application URL is used as a fallback.
 */
export function toPlaywrightCookies(cookies: AuthCookie[], fallbackUrl: string): PlaywrightCookie[] {
    return cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        expires: cookie.expires,
        sameSite: normalizeSameSite(cookie.sameSite),
        ...resolveLocation(cookie, fallbackUrl),
    }));
}

function resolveLocation(cookie: AuthCookie, fallbackUrl: string): Pick<PlaywrightCookie, "url" | "domain" | "path"> {
    if (cookie.url != null) return { url: cookie.url };
    if (cookie.domain != null) return { domain: cookie.domain, path: cookie.path ?? "/" };
    return { url: fallbackUrl };
}
