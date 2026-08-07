import { z } from "zod";

/**
 * What to tell someone whose GitHub App install did not complete.
 *
 * The install callback can land on several different pages (onboarding, an app's GitHub
 * settings, or the standalone result page), so the copy lives here rather than in whichever
 * route happened to need it first. Every message names the accounts on both sides and gives
 * exactly one next action - the previous single "Please try again" was actively misleading for
 * the two conflict cases, where retrying can never succeed.
 */

/**
 * Only ever a link to manage an installation on GitHub.
 *
 * The value arrives in the query string, so anything goes in - including `javascript:`, which
 * would render an executable link. Narrowing it to a GitHub URL means a tampered link degrades to
 * no link rather than to a payload. The API only ever sends `configureInstallationUrl`, so nothing
 * legitimate is lost. `.catch(undefined)` keeps a bad value from failing the whole route's search
 * parsing, which would replace the error page with a router error.
 */
export const manageUrlSchema = z
    .string()
    .url()
    .refine((value) => value.startsWith("https://github.com/"))
    .optional()
    .catch(undefined);

/** What the callback appends to the return URL when an install could not be completed. */
export interface InstallFailure {
    /** GitHub account currently connected to the workspace. */
    account?: string;
    /** The account the user just tried to add. */
    attempted?: string;
}

/**
 * Autonoma connects one GitHub account per workspace. Everything that exists only because of that
 * limit hangs off this flag, so lifting it is one edit here plus deleting what stops compiling -
 * rather than a hunt for copy that quietly went stale.
 *
 * When it becomes true: the API stops emitting `account_already_connected`, and the note below and
 * that error's copy can go.
 */
export const SUPPORTS_MULTIPLE_GITHUB_ACCOUNTS = false;

/**
 * The standing explanation of the one-account limit, shown on a connected workspace before anyone
 * trips over it. Lives here rather than inline in the settings panel so it cannot drift from the
 * error copy that says the same thing, and so it disappears with the flag above.
 */
export function singleAccountLimitNote(accountLogin: string): string | undefined {
    if (SUPPORTS_MULTIPLE_GITHUB_ACCOUNTS) return undefined;
    return (
        `Autonoma can't use two GitHub accounts at once yet, so installing it on a second account will not work. ` +
        `To use a repository under a different account, grant this installation access to it on GitHub. To move ` +
        `this workspace to another account for good, uninstall Autonoma from ${accountLogin} on GitHub first - ` +
        `Disconnect below does that for you, and also unlinks every application's repository.`
    );
}

/**
 * What the install button should say, when a failure changes what pressing it actually does.
 *
 * `unattributed` is the case that needs it: the app is ALREADY installed, so a button reading
 * "Install GitHub App" tells the user to do the thing they just did - which is exactly why the
 * screen read as nonsense. The action there is linking an existing installation, and the button
 * should say so. Undefined means the caller keeps its own default.
 */
export function installActionLabel(error: string | undefined): string | undefined {
    return error === "unattributed" ? "Link GitHub installation" : undefined;
}

/**
 * The lead paragraph above the install button, when a failure makes the default one wrong.
 *
 * The default tells the reader to install the app and grant repository access. Someone who has
 * already installed reads that as "you did not do it properly" and starts over.
 */
export function installLeadOverride(error: string | undefined): string | undefined {
    return error === "unattributed"
        ? "The app is installed on GitHub already - this last step links that installation to this Autonoma workspace."
        : undefined;
}

/**
 * How loudly to render a failure. `unattributed` is not a failure at all - the install worked and
 * one click finishes it - so shouting it in critical red misreads as "something is broken" and
 * sends people looking for a problem that is not there.
 */
export function installFailureTone(error: string): "critical" | "info" {
    return error === "unattributed" ? "info" : "critical";
}

/**
 * Whether the install button should stay disabled while this error is on screen.
 *
 * Retrying a conflict lands on the same conflict - the blocker is on GitHub, and pressing the
 * button again just spends a round trip to be told so a second time. `unattributed` is the
 * opposite: pressing the button IS the fix, so it stays enabled.
 */
export function installFailureBlocksRetry(error: string): boolean {
    return error === "account_already_connected" || error === "account_claimed_elsewhere";
}

export function installFailureTitle(error: string): string {
    switch (error) {
        case "unattributed":
            return "You already installed the app - now link it to this workspace";
        case "account_already_connected":
            return "Connecting a second GitHub account isn't supported yet";
        case "account_claimed_elsewhere":
            return "That GitHub account is connected to another workspace";
        case "stale_installation":
            return "That installation is too old to connect this way";
        case "install_cancelled":
            return "Installation cancelled";
        default:
            return "Couldn't connect GitHub";
    }
}

export function installFailureBody(error: string, { account, attempted }: InstallFailure): string {
    const connected = account ?? "another GitHub account";
    const tried = attempted ?? "the account you chose";

    switch (error) {
        case "unattributed":
            return (
                "You installed the Autonoma GitHub App on GitHub. That part is done and you do not need to install " +
                "it again. What is left is linking that installation to this workspace - and the link has to be " +
                "started from here, because that is how Autonoma knows the installation is yours to connect. " +
                "Do it now, while the installation is still new:"
            );
        case "account_already_connected":
            return (
                `This workspace is connected to ${connected}, and Autonoma can't use two GitHub accounts at once ` +
                `yet - so ${tried} was not added and your existing connection is untouched. Nothing is broken. ` +
                `If you only need a repository that lives under ${tried}, you don't have to switch at all: grant ` +
                `the ${connected} installation access to that repository instead. To move this workspace to ` +
                `${tried} for good:`
            );
        case "account_claimed_elsewhere":
            return (
                `${tried} is already connected to a different Autonoma workspace, and a GitHub account can only be ` +
                `connected to one at a time. Retrying will not change that. Usually this is another workspace at ` +
                `your own company - someone tried Autonoma before, or signed up with a different email. You can move ` +
                `it here yourself, from GitHub, without needing access to that workspace:`
            );
        case "stale_installation":
            return (
                "For security, Autonoma only connects an installation that was created moments ago, and this one is " +
                "older than that - so nothing was connected. This usually means the app was installed on GitHub a " +
                "while before anyone came back here to finish. Installing again will not help on its own, because " +
                "GitHub keeps the same installation. Do this instead:"
            );
        case "install_cancelled":
            return "The GitHub App installation was cancelled, so nothing changed.";
        case "install_failed":
            return "Something went wrong connecting GitHub. Try again, and contact support if it keeps happening.";
        default:
            return `GitHub returned an unexpected result (${error}). Try again, and contact support if it keeps happening.`;
    }
}

/**
 * Label for the outbound GitHub link, which points at a DIFFERENT installation per failure: the
 * one already connected when a second account is refused, and the one holding the account when it
 * belongs to another workspace. Naming the account in the link is what makes it obvious which of
 * the two you are about to uninstall.
 */
export function installFailureManageLabel(error: string, { account, attempted }: InstallFailure): string {
    switch (error) {
        case "account_already_connected":
            return account != null ? `Uninstall Autonoma from ${account} on GitHub` : "Manage that installation";
        case "account_claimed_elsewhere":
            return attempted != null ? `Uninstall Autonoma from ${attempted} on GitHub` : "Manage that installation";
        default:
            return "Manage that installation on GitHub";
    }
}

/**
 * The ordered way out, for the failures that have one. Steps rather than a paragraph because
 * switching accounts is a multi-step job that spans GitHub and Autonoma, and the previous single
 * sentence ("disconnect below first") named only the Autonoma half - leaving the GitHub
 * installation in place and the user unsure whether it mattered.
 */
export function installFailureSteps(error: string, { account, attempted }: InstallFailure): string[] {
    const connected = account ?? "the connected account";
    const tried = attempted ?? "the other account";

    switch (error) {
        case "unattributed":
            return [
                "Click Link GitHub installation above.",
                "Pick the same GitHub account you installed on. GitHub sees the app is already there, so it only " +
                    "asks you to confirm - nothing is installed a second time.",
                "That is it. You land back here linked, and can pick your repository.",
            ];
        case "account_already_connected":
            return [
                // Deliberately not "the Disconnect button below": this copy also renders on the
                // onboarding install screen, which has no such button.
                `On GitHub, open the Autonoma installation on ${connected} and uninstall it. Disconnect on the app's ` +
                    `GitHub settings page does the same thing, and also unlinks every application's repository.`,
                `Come back and install the Autonoma GitHub App again, choosing ${tried}. If you already installed ` +
                    `it there just now, GitHub only asks you to confirm - you will not install anything twice.`,
            ];
        case "stale_installation":
            return [
                "On GitHub, uninstall the Autonoma GitHub App from the account you installed it on.",
                "Come back and install it again from here. GitHub creates a brand-new installation, which connects " +
                    "straight away.",
            ];
        case "account_claimed_elsewhere":
            return [
                `On GitHub, open the Autonoma installation on ${tried} and uninstall it. You do not need access to ` +
                    `the other Autonoma workspace for this - being a GitHub admin of ${tried} is enough.`,
                `Come back and install the Autonoma GitHub App again from here. GitHub creates a fresh installation, ` +
                    `and this workspace gets it. The other workspace simply no longer has it.`,
            ];
        default:
            return [];
    }
}
