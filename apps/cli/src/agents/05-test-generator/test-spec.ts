import { z } from "zod";
import { echoesStepGuidance, STEP_DESCRIPTION_GUIDANCE, STEP_LOCATION_GUIDANCE } from "./step-guidance";
import { CRITICALITY_LEVELS, requiresLocation, STEP_VERBS, type StepVerb } from "./validation";

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

/**
 * The `flow` field, closed over the run's valid flow ids when there are any.
 *
 * A flow id from flows.json, not free text. Left open it collapsed into the page
 * name - real runs produced `flow: "Companies list view."` and `flow: "Team
 * Settings"` - and ~13% of tests carried an id no flow ever declared, so the field
 * that exists to tie a test to a user journey could not be machine-joined to its
 * tier at all. The valid ids are a closed, machine-generated, kebab-case set, so
 * membership is structurally decidable and safe to enforce here - unlike anything
 * about what a sentence MEANS, which stays in the review rubrics. When the set is
 * empty (a degraded run with no ranking) the field stays permissive, so those runs
 * are unaffected.
 */
function flowField(validFlowIds?: ReadonlySet<string>) {
    const ids = validFlowIds != null && validFlowIds.size > 0 ? validFlowIds : undefined;
    const idList = ids != null ? [...ids].join(", ") : "";
    const description =
        ids != null
            ? `The flow id this test belongs to. Must be one of, copied verbatim: ${idList}.`
            : "The flow id this test belongs to, exactly as listed in the flows you were given.";
    // The refine is always attached so the field keeps one static type; it is a
    // no-op when there is no ranking, which is what makes degraded runs permissive.
    return z
        .string()
        .min(1)
        .describe(description)
        .refine((flow) => ids == null || ids.has(flow), {
            message: `Not one of this run's flow ids. Use exactly one of these, copied verbatim: ${idList}.`,
        });
}

const stepSchema = z
    .object({
        verb: z.enum(STEP_VERBS).describe("The action. Only these verbs exist."),
        description: z.string().min(1).describe(STEP_DESCRIPTION_GUIDANCE),
        location: z.string().optional().describe(STEP_LOCATION_GUIDANCE),
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
    })
    // A weak model sometimes quotes a field's own guidance back into the value
    // instead of following it - a real run copied the location guidance into the
    // description of every step of five journey files, past the refines above
    // (non-empty, no placeholder token). write_test retries on failure, so
    // rejecting the step self-heals by regenerating it.
    .refine((step) => !echoesStepGuidance(step.description) && !echoesStepGuidance(step.location), {
        message:
            "this quotes the field's own guidance instead of describing the screen - write the actual target text and location",
        path: ["description"],
    });

export type TestStep = z.infer<typeof stepSchema>;

/**
 * The test-spec schema, optionally closed over the run's valid flow ids so the
 * `flow` field rejects anything outside the closed set. Called with no argument -
 * or with an empty set - it is the permissive schema the journey pass and the
 * degraded (no-ranking) runs use unchanged.
 */
export function buildTestSpecSchema(validFlowIds?: ReadonlySet<string>) {
    return z.object({
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
        flow: flowField(validFlowIds),
        verification: z
            .string()
            .min(20)
            .describe(
                "WHERE to navigate and WHAT to assert to prove the mutation worked. Must name the source of truth - a toast, a confirmation dialog or an inline success indicator is an acknowledgment, not proof. When the test commits a create/edit/delete/save of a record that should PERSIST, this must reload (refresh) and re-assert the same entity/value/status - an in-page assertion right after a mutation can pass on an optimistic update that never persisted. Skip the reload for validation-blocked writes (nothing was created), pure navigation/auth, and ephemeral/real-time/session state.",
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
                "Steps that navigate to the source of truth and assert the mutation landed. Implements the `verification` field above. For a persisted-record create/edit/delete/save, these must include a refresh followed by re-asserting the same entity/value/status - an in-page assertion right after the mutation can pass on an optimistic update that never persisted. Omit the reload for validation-blocked writes, pure navigation/auth, and ephemeral/real-time/session state, where a reload would prove nothing or be wrong.",
            ),
        expectedResult: z.string().min(1).describe("What should be true when the test passes."),
        notes: z
            .string()
            .optional()
            .describe(
                "Optional free text for anything you could not resolve or want to flag - an ambiguous default state, a element you could not find in the source, an assumption you had to make. Recorded for humans and NEVER written into the test file, so it will not affect execution. Use it instead of guessing silently.",
            ),
    });
}

/** The permissive schema: the journey pass and no-ranking runs write against this. */
export const testSpecSchema = buildTestSpecSchema();

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
            const description = stripLeadingVerb(step.verb, step.description);
            const location = step.location?.trim();
            const text = location != null && location !== "" ? `${description} ${location}` : description;
            return `${index + 1}. ${step.verb}: ${text}`;
        })
        .join("\n");
}

/**
 * The step's target text with a redundant leading copy of the step's OWN verb
 * removed. The verb is rendered once as the marker; the model is told not to
 * repeat it, but sometimes does ("assert: the heading appears", "click the
 * button"), which would render as a doubled marker (`1. assert: assert: ...`) -
 * malformed against the `N. verb: target` contract the downstream platform
 * parses. The match is anchored to the start and word-bounded, so only the
 * step's own verb is stripped: a legitimate "Refresh" inside an assert, or
 * "typescript" after a type, is never touched. A description that is nothing but
 * the verb is left as-is rather than emptied.
 */
function stripLeadingVerb(verb: StepVerb, description: string): string {
    const leadingOwnVerb = new RegExp(`^\\s*${verb}\\b:?\\s*`, "i");
    const cleaned = description.replace(leadingOwnVerb, "");
    return cleaned.length > 0 ? cleaned : description;
}
