import { z } from "zod";
import { CRITICALITY_LEVELS, isInteractionVerb, MIN_INTERACTIONS, requiresLocation, STEP_VERBS } from "./validation";

/**
 * The shape of a generated test, and the one place it becomes markdown.
 *
 * `write_test` used to take the finished file as a string and then re-derive its
 * structure with a frontmatter parse and four regexes. That made every rule
 * advisory: an illegal verb, a missing location, a placeholder token were all
 * things the model could emit and we could only complain about afterwards. As a
 * schema they are unrepresentable, and the AI SDK makes the model retry against
 * the validator instead of against a returned error string it may ignore.
 *
 * The rendered markdown is a product contract - it ships to a platform that
 * requires exactly this layout - so rendering happens here, once, deterministically.
 * Two models producing the same test now produce byte-identical files.
 */

/**
 * Placeholder SYNTAX a step may never contain. These are tokens, not prose - a
 * test carries no variables, so `{{x}}` or "Dynamic:" is unresolvable at run
 * time whatever the surrounding sentence says.
 *
 * Nothing else here judges language. Rules about what a sentence MEANS - whether
 * a setup logs the user in, whether a step names two possible targets - belong to
 * the review rubrics, which are model calls and can read intent. Two attempts at
 * doing that with a pattern both misfired: one rejected the application's own
 * "Invalid email or password", the other rejected "the user is on the login
 * page" and cost a run 680 retries and $11 for zero tests. A regex cannot
 * enumerate the ways a sentence can be fine.
 */
const PLACEHOLDER_PATTERNS: { pattern: RegExp; name: string }[] = [
    { pattern: /Dynamic:\s/i, name: '"Dynamic:" placeholder' },
    { pattern: /\{\{[a-zA-Z0-9_]+\}\}/, name: "{{token}} placeholder" },
    { pattern: /(?<!\{)\{[a-z][a-zA-Z]*\}(?!\})/, name: "bare {variable}" },
    { pattern: /\be\.g\./i, name: '"e.g." example' },
];

function hasPlaceholder(text: string | undefined): boolean {
    if (text == null) return false;
    return PLACEHOLDER_PATTERNS.some(({ pattern }) => pattern.test(text));
}

const stepSchema = z
    .object({
        verb: z.enum(STEP_VERBS).describe("The action. Only these verbs exist."),
        description: z
            .string()
            .min(1)
            .describe(
                "What to do or check, naming the exact visible text. For assert, the thing expected on screen - e.g. 'text \"Transfer Successful\"'.",
            ),
        location: z
            .string()
            .optional()
            .describe(
                'WHERE on screen the target is - "in the modal", "in the toast notification", "on the Sony WH-1000XM5 product card", "in the dashboard header", "as a page heading". REQUIRED for click, type and assert: the same label routinely appears more than once (a header button and the modal button it opens, "Buy" on every card in a list), and acting on the wrong one fails confusingly. Not needed for scroll or refresh, which act on the page.',
            ),
    })
    .refine((step) => !requiresLocation(step.verb) || (step.location?.trim() ?? "") !== "", {
        message:
            'This verb requires a "location" - say WHERE on screen its target is. The same label often appears more than once (a header button and the modal button it opens), so naming the element is not enough on its own.',
        path: ["location"],
    })
    // Both fields, because both are rendered onto the same step line. Checking
    // only the description left `location` as an unguarded way to smuggle a
    // `{{token}}` into a test - and the final on-disk sweep looks for "Dynamic:"
    // alone, so nothing downstream caught it either.
    .refine((step) => !hasPlaceholder(step.description) && !hasPlaceholder(step.location), {
        message: "steps carry no variables - use the exact value from the test data, not a placeholder or example",
        path: ["description"],
    });

export type TestStep = z.infer<typeof stepSchema>;

export const testSpecSchema = z
    .object({
        title: z.string().min(1).describe("Short, descriptive test name."),
        description: z.string().min(1).describe("One sentence explaining what the test verifies."),
        intent: z
            .string()
            .min(30)
            .describe(
                "A specific, falsifiable claim derived from the node's mission: what the user does, what the feature produces, why it matters. Not the steps, not 'the page displays correctly'.",
            ),
        criticality: z.enum(CRITICALITY_LEVELS),
        scenario: z.string().min(1).describe('Which scenario this test uses (usually "standard").'),
        flow: z.string().min(1).describe("Which feature/flow this belongs to (must match a flow from AUTONOMA.md)."),
        verification: z
            .string()
            .min(20)
            .describe(
                "WHERE to navigate and WHAT to assert to prove the mutation worked. Must name the source of truth - a toast, a confirmation dialog or an inline success indicator is an acknowledgment, not proof.",
            ),
        setup: z
            .string()
            .min(1)
            .describe(
                "Which page the user starts on and how they got there. Never authentication - the user is already signed in.",
            ),
        steps: z.array(stepSchema).min(1).describe("The action sequence, in order."),
        verificationSteps: z
            .array(stepSchema)
            .describe(
                "Steps that navigate to the source of truth and assert the mutation landed. Implements the `verification` field above.",
            ),
        expectedResult: z.string().min(1).describe("What should be true when the test passes."),
        notes: z
            .string()
            .optional()
            .describe(
                "Optional free text for anything you could not resolve or want to flag - an ambiguous default state, a element you could not find in the source, an assumption you had to make. Recorded for humans and NEVER written into the test file, so it will not affect execution. Use it instead of guessing silently.",
            ),
    })
    .refine((spec) => spec.steps.filter((step) => isInteractionVerb(step.verb)).length >= MIN_INTERACTIONS, {
        message: `A test needs at least ${MIN_INTERACTIONS} real interactions (click/type/drag) - a visibility-only test verifies nothing`,
        path: ["steps"],
    });

export type TestSpec = z.infer<typeof testSpecSchema>;

/** Render a validated spec as the markdown the platform expects. */
export function renderTestMarkdown(spec: TestSpec): string {
    const frontmatter = [
        "---",
        `title: ${JSON.stringify(spec.title)}`,
        `description: ${JSON.stringify(spec.description)}`,
        `intent: ${JSON.stringify(spec.intent)}`,
        `criticality: ${spec.criticality}`,
        `scenario: ${spec.scenario}`,
        `flow: ${JSON.stringify(spec.flow)}`,
        `verification: ${JSON.stringify(spec.verification)}`,
        "---",
    ].join("\n");

    const sections = [
        frontmatter,
        `**Setup**: ${spec.setup}`,
        `**Intent**: ${spec.intent}`,
        `**Steps**:\n${renderSteps(spec.steps)}`,
    ];

    if (spec.verificationSteps.length > 0) {
        sections.push(`**Verification**:\n${renderSteps(spec.verificationSteps)}`);
    }
    sections.push(`**Expected Result**: ${spec.expectedResult}`);

    return `${sections.join("\n\n")}\n`;
}

function renderSteps(steps: TestStep[]): string {
    return steps
        .map((step, index) => {
            const location = step.location?.trim();
            const text = location != null && location !== "" ? `${step.description} ${location}` : step.description;
            return `${index + 1}. ${step.verb}: ${text}`;
        })
        .join("\n");
}
