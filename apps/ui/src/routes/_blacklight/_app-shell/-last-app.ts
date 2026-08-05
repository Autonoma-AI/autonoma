/**
 * Which application to reopen when someone lands on the app shell with nowhere
 * particular to go.
 *
 * Keyed by application id, which is unique everywhere. A slug is unique only
 * WITHIN an organization (`@@unique([slug, organizationId])` on Application), so
 * storing one and reading it back after an org switch resolves to whichever app
 * that organization happens to call the same thing - silently reopening a
 * different application than the one that was stored. Nothing escapes the
 * organization either way (the list this is matched against is server-scoped),
 * but landing in the wrong app looks like a bug in the app switcher.
 */
const LAST_APP_KEY = "lastApplicationId";

export function getLastAppId(): string | undefined {
    return localStorage.getItem(LAST_APP_KEY) ?? undefined;
}

export function setLastAppId(applicationId: string): void {
    localStorage.setItem(LAST_APP_KEY, applicationId);
}

export function clearLastAppId(): void {
    localStorage.removeItem(LAST_APP_KEY);
}
