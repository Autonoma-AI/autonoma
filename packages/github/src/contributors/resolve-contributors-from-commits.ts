import { logger as rootLogger } from "@autonoma/logger";
import { parseCoAuthoredByTrailers } from "./parse-co-authors";

/**
 * The minimal commit shape the contributor resolver reads: the message (for `Co-authored-by:` trailers) and
 * the author login (present only when GitHub linked the commit email to an account).
 */
export interface CommitForContributors {
    message: string;
    authorLogin?: string;
}

/**
 * One person who contributed to a branch/PR: a commit author, a `Co-authored-by:` co-author, or the PR
 * opener. A branch has more than one author, so attributing its outcome to the opener alone is wrong - this
 * is the atomic unit the per-developer stickiness signal is attributed to.
 *
 * `login` is the GitHub login, present only when it could be resolved (commit authors linked to an account,
 * or the opener). Co-authors carry only `displayName`/`email` from their trailer, so their `login` is absent;
 * ask `isUnresolved` when you need that distinction rather than storing a derived flag.
 *
 * A single human can appear as two contributors when GitHub gives no email->login mapping: once by `login`
 * (a linked commit author) and once by `email` (a `Co-authored-by:` trailer). Consumers that count distinct
 * developers should dedupe by `login` where present and treat login-less rows as best-effort.
 */
export interface ResolvedContributor {
    login?: string;
    displayName?: string;
    email?: string;
    isOpener: boolean;
}

/** A contributor GitHub could not map to an account (co-authors, or commit emails not linked to a login). */
export function isUnresolved(contributor: { login?: string }): boolean {
    return contributor.login == null;
}

/**
 * Stable dedup/identity key for a contributor: prefer the GitHub login, fall back to the email, then the display name.
 */
export function contributorKey(contributor: { login?: string; email?: string; displayName?: string }): string {
    const key = contributor.login ?? contributor.email ?? contributor.displayName;
    if (key == null || key.trim() === "") {
        throw new Error("Cannot derive a contributor key: login, email, and displayName are all absent");
    }
    return key.toLowerCase();
}

export interface ResolveContributorsOptions {
    /** The PR opener's GitHub login. Always included in the result, flagged `isOpener`. */
    openerLogin?: string;
}

/**
 * Collapse a PR's commits (plus the opener) into a deduped contributor set. Every commit's `authorLogin` is
 * captured when GitHub linked the email to an account, and every `Co-authored-by:` trailer in each commit
 * message is parsed and added (as an unresolved name/email, since trailers carry no login). The opener is
 * merged in last so an opener who also pushed commits is a single row flagged `isOpener`.
 */
export function resolveContributorsFromCommits(
    commits: ReadonlyArray<CommitForContributors>,
    options: ResolveContributorsOptions = {},
): ResolvedContributor[] {
    const logger = rootLogger.child({ name: "resolveContributorsFromCommits" });

    const byKey = new Map<string, ResolvedContributor>();

    const upsert = (candidate: { login?: string; displayName?: string; email?: string; isOpener: boolean }) => {
        const key = contributorKey(candidate);
        const existing = byKey.get(key);
        if (existing == null) {
            byKey.set(key, {
                login: candidate.login,
                displayName: candidate.displayName,
                email: candidate.email,
                isOpener: candidate.isOpener,
            });
            return;
        }

        byKey.set(key, {
            login: existing.login ?? candidate.login,
            displayName: existing.displayName ?? candidate.displayName,
            email: existing.email ?? candidate.email,
            isOpener: existing.isOpener || candidate.isOpener,
        });
    };

    for (const commit of commits) {
        if (commit.authorLogin != null && commit.authorLogin !== "") {
            upsert({ login: commit.authorLogin, isOpener: false });
        }
        for (const coAuthor of parseCoAuthoredByTrailers(commit.message)) {
            upsert({ displayName: coAuthor.name, email: coAuthor.email, isOpener: false });
        }
    }

    if (options.openerLogin != null && options.openerLogin !== "") {
        upsert({ login: options.openerLogin, isOpener: true });
    }

    const contributors = [...byKey.values()];
    logger.debug("Resolved branch contributors", {
        extra: { commitCount: commits.length, contributorCount: contributors.length },
    });
    return contributors;
}
