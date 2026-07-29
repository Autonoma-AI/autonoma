import { logger as rootLogger } from "@autonoma/logger";

/**
 * A `Co-authored-by:` trailer parsed out of a commit message. GitHub attributes a co-author by name and
 * email only - never a login - so this carries exactly what the trailer holds.
 */
export interface CoAuthorTrailer {
    name: string;
    email: string;
}

/**
 * Matches a `Co-authored-by: Name <email>` git trailer.
 */
const CO_AUTHORED_BY_LINE = /^[ \t]*co-authored-by:[ \t]*(.+?)[ \t]*<([^>]+)>[ \t]*$/gim;

/**
 * Extract every `Co-authored-by:` trailer from a commit message, deduped by email (case-insensitive). A
 * commit with no trailers returns an empty array.
 */
export function parseCoAuthoredByTrailers(message: string): CoAuthorTrailer[] {
    const logger = rootLogger.child({ name: "parseCoAuthoredByTrailers" });

    const seenEmails = new Set<string>();
    const trailers: CoAuthorTrailer[] = [];
    for (const match of message.matchAll(CO_AUTHORED_BY_LINE)) {
        const name = match[1]?.trim();
        const email = match[2]?.trim();
        if (name == null || name === "" || email == null || email === "") continue;

        const emailKey = email.toLowerCase();
        if (seenEmails.has(emailKey)) continue;
        seenEmails.add(emailKey);
        trailers.push({ name, email });
    }

    if (trailers.length > 0) {
        logger.debug("Parsed co-authored-by trailers", { extra: { count: trailers.length } });
    }
    return trailers;
}
