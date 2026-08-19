import { generateText, type LanguageModel, Output } from "ai";
import { z } from "zod";
import { debugLog } from "../../core/debug";
import { AI_MAX_RETRIES } from "../../core/model";

/**
 * Decides which proposed tests restate behaviour the suite already covers.
 *
 * A model call rather than string similarity, because the question is about
 * meaning: "Transfer money from Savings to Checking" and "Move funds between own
 * accounts" are the same test, while "Send money to an external business" and
 * "Send money to an external individual" are different ones that share almost
 * every word. No amount of token overlap separates those two cases.
 *
 * Deliberately conservative. A false positive here deletes coverage silently -
 * the test is never written and nothing downstream knows it was wanted - which
 * is worse than the duplicate it prevents.
 */

const SYSTEM_PROMPT = `You decide whether a proposed E2E test covers behaviour that an existing test already covers.

Each test is labelled with the page it runs on, in [brackets]. The page is part of a test's
identity: two tests whose sentences read almost identically but which run on DIFFERENT pages are
DISTINCT - "shows a validation error when required fields are empty" on a sign-up page and the same
sentence on a workspace-creation page fail for entirely different reasons even though the words match.
Generic assertions about data, lists and forms collide this way constantly; the page is what tells
them apart. Two similar tests on the SAME page can still be duplicates.

Two tests are DUPLICATES when they would fail for the same reason - they exercise the same user
action against the same feature and assert the same outcome. Different wording does not make
them different tests.

Two tests are DISTINCT when either could fail while the other passes. In particular:
- Tests on different pages are almost always DISTINCT (see above).
- Different variants that take different code paths (an internal vs an external transfer, a
  physical vs a virtual card) are DISTINCT even when the sentences look nearly identical.
- A happy path and its validation/error case are DISTINCT.
- The same action from a different entry point is DISTINCT only if the flow genuinely differs;
  if it ends in the same form doing the same thing, it is a duplicate.

Be conservative: when you are not confident two tests would fail for the same reason, treat the
proposal as DISTINCT. Wrongly rejecting a proposal removes coverage that nobody will notice is
missing; wrongly accepting one costs a redundant test that review can still catch.`;

const verdictSchema = z.object({
    verdicts: z.array(
        z.object({
            proposed: z.string().describe("The proposed description, copied verbatim."),
            duplicateOf: z
                .string()
                .optional()
                .describe(
                    "The EXISTING description it duplicates, verbatim. Omit entirely when the proposal is distinct.",
                ),
        }),
    ),
});

/**
 * A test to judge, paired with the page it exercises. The page scopes the
 * comparison: it is the difference between merging two genuine duplicates and
 * wrongly merging two generically-phrased tests that happen to share words but
 * live on different pages.
 */
export interface JudgeTest {
    /** A human-readable page label (route path or name) the description is scoped to. */
    page: string;
    description: string;
}

export interface DuplicateJudgeInput {
    model: LanguageModel;
    /** Tests already claimed by the run, each with its page. */
    existing: readonly JudgeTest[];
    proposed: readonly JudgeTest[];
}

export interface DuplicateVerdict {
    duplicateOf?: string;
}

/**
 * Map from each proposed description to its verdict. A proposal missing from the
 * result is treated as distinct by the caller - the judge failing must not block
 * a test from being written.
 */
export async function judgeDuplicates({
    model,
    existing,
    proposed,
}: DuplicateJudgeInput): Promise<Map<string, DuplicateVerdict>> {
    const verdicts = new Map<string, DuplicateVerdict>();
    // Nothing to compare against: the first node's proposals are all new.
    if (existing.length === 0) return verdicts;

    const prompt = `Each test is prefixed with the page it exercises, in [brackets].

## Tests the suite already covers
${existing.map((t, i) => `${i + 1}. [${t.page}] ${t.description}`).join("\n")}

## Proposed new tests
${proposed.map((t, i) => `${i + 1}. [${t.page}] ${t.description}`).join("\n")}

For each proposed test, say whether it duplicates one of the existing ones - remembering that tests
on different pages are almost always distinct. Return a verdict for every proposal, copying its
description verbatim WITHOUT the page prefix.`;

    try {
        const { output } = await generateText({
            model,
            output: Output.object({ schema: verdictSchema }),
            system: SYSTEM_PROMPT,
            prompt,
            temperature: 0,
            maxRetries: AI_MAX_RETRIES,
        });
        for (const v of output.verdicts) {
            // An empty string is the model declining to name a duplicate; treat it
            // as distinct rather than as a duplicate of nothing.
            const of = v.duplicateOf?.trim();
            verdicts.set(v.proposed, of != null && of !== "" ? { duplicateOf: of } : {});
        }
    } catch (err) {
        // Fail open: an unavailable judge must not stop the run writing tests. The
        // cost of that is a duplicate; the cost of failing closed is no suite.
        debugLog("Duplicate judge failed; treating every proposal as distinct", { err });
    }

    return verdicts;
}
