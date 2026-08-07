/** The GitHub account an installation sits on, as much of it as a URL needs. */
export interface InstallationAccountRef {
    login: string;
    /** GitHub's account kind: "Organization" or "User". */
    type: string;
}

/**
 * Where a user manages one specific installation of the app: grant it more repositories, or
 * uninstall it.
 *
 * The path differs by account kind, and getting it wrong is a 404 rather than a redirect - an
 * organization's installation does NOT live under the personal `/settings/installations/<id>`,
 * and sending someone there is a dead end at exactly the moment they are trying to fix something.
 *
 * Deliberately NOT `https://github.com/apps/<slug>/installations/new`: that is GitHub's account
 * picker, so a link meant to say "grant this installation more access" doubles as the shortest
 * path to installing on a second account, which Autonoma cannot use.
 *
 * Falls back to the personal form when the account kind is unknown - it is right for user
 * accounts and no worse than nothing for organizations.
 */
export function configureInstallationUrl(installationId: number, account?: InstallationAccountRef): string {
    if (account?.type === "Organization") {
        return `https://github.com/organizations/${account.login}/settings/installations/${installationId}`;
    }
    return `https://github.com/settings/installations/${installationId}`;
}
