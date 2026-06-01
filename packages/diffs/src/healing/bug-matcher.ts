import { type LanguageModel, ObjectGenerator } from "@autonoma/ai";
import type { BugStatus, PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { z } from "zod";

interface ExistingBug {
    id: string;
    title: string;
    description: string;
    status: BugStatus;
}

export interface BugCandidate {
    title: string;
    description: string;
}

const matchResultSchema = z.object({
    matchedBugId: z
        .string()
        .nullable()
        .describe("ID of the existing bug that matches the candidate, or null if none match"),
    reasoning: z.string().describe("Why this candidate matches (or doesn't) an existing bug"),
});

type MatchResult = z.infer<typeof matchResultSchema>;

const SYSTEM_PROMPT = `You are a bug deduplication service. Given one new issue candidate and the list
of existing tracked bugs for the same application, decide whether the candidate describes the same
underlying bug as one of them.

Two reports describe the same bug if they share a root cause - not just similar symptoms. Some
worked examples:

- "Login button unresponsive" and "Cannot click Sign In" likely describe the same bug.
- "Login failed: network error during auth" and "Auth call returns 503 on login" likely describe
  the same bug, even though the wording differs.
- "Login button unresponsive" and "Login page CSS broken" are different bugs even though both
  affect the login page.

Focus on:
- Whether fixing one report would also fix the other.
- Whether they describe the same failure mode and root cause.

Do NOT match reports that merely touch the same area of the application but have different root
causes. Status alone (open / resolved) is not a reason to match or not match - if a resolved bug
matches the candidate, return its ID; the caller will reopen it.`;

export class BugMatcher {
    private readonly logger: Logger;
    private readonly objectGenerator: ObjectGenerator<MatchResult>;

    constructor(
        private readonly db: PrismaClient,
        private readonly applicationId: string,
        model: LanguageModel,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name, applicationId });
        this.objectGenerator = new ObjectGenerator({
            model,
            systemPrompt: SYSTEM_PROMPT,
            schema: matchResultSchema,
            retry: { maxRetries: 3, initialDelayInMs: 200, backoffFactor: 2 },
        });
    }

    async findMatch(candidate: BugCandidate): Promise<string | undefined> {
        this.logger.info("Looking for matching bug", { title: candidate.title });

        const existing = await this.db.bug.findMany({
            where: { applicationId: this.applicationId },
            select: { id: true, title: true, description: true, status: true },
            orderBy: { lastSeenAt: "desc" },
        });

        if (existing.length === 0) {
            this.logger.info("No existing bugs in application; candidate is novel");
            return undefined;
        }

        const result = await this.objectGenerator.generate({ userPrompt: buildPrompt(existing, candidate) });
        const matchedBugId = result.matchedBugId ?? undefined;

        if (matchedBugId != null && !existing.some((b) => b.id === matchedBugId)) {
            this.logger.warn("Model returned non-existent bug ID, treating as unmatched", { matchedBugId });
            return undefined;
        }

        this.logger.info("Match decision", { matchedBugId, reasoning: result.reasoning });
        return matchedBugId;
    }
}

function buildPrompt(existing: ExistingBug[], candidate: BugCandidate): string {
    const existingList = existing
        .map((b) => `- Bug ID: ${b.id}\n  Status: ${b.status}\n  Title: ${b.title}\n  Description: ${b.description}`)
        .join("\n\n");

    return `## New Issue Candidate

Title: ${candidate.title}
Description: ${candidate.description}

## Existing Bugs in This Application

${existingList}

Decide whether the candidate describes the same underlying bug as one of the existing bugs above.
Set matchedBugId to the existing bug's ID if it matches, or null if no existing bug matches.`;
}
