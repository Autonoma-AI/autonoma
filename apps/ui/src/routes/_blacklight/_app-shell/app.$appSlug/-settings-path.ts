/**
 * Whether a path under this app is one of its settings pages.
 *
 * Settings are exempt from the onboarding gate on the app route. That gate exists
 * to keep a half-configured app out of a dashboard it cannot fill; settings are the
 * opposite, because the setup steps themselves link out to API keys and preview
 * configuration - in a new tab, precisely while setup is unfinished. Gating those
 * would make the flow's own links land back on the flow.
 *
 * Matched on the pathname because the check runs inside a route loader, which has a
 * location but no route matcher. The slug is part of the prefix so a path under a
 * different app cannot open the gate for this one.
 */
export function isSettingsPath(pathname: string, appSlug: string): boolean {
    return pathname.startsWith(`/app/${appSlug}/settings`);
}
