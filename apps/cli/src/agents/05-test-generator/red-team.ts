import type { RiskDriver } from "../01-kb-generator/flow-spec";
import type { FlowBudget } from "./budget";

/**
 * What to attack, given how a flow can break.
 *
 * The reason budget converts into attacks rather than more tests: a flow only has
 * so many sub-flows, and past that point another happy path proves nothing new.
 * The best test this system has produced came from an agent that was handed a
 * specific claim - a chat had just been changed to refuse harmful content - and
 * tried to falsify it in several languages until it succeeded. What made that work
 * was knowing the property to break, not being told to be adversarial.
 *
 * So each driver names concrete things to try, and the flow's own invariants supply
 * the claims. An agent told "only the owner can view this document" writes a sharp
 * test; one told "think about security" writes noise.
 */
const PLAYBOOKS: Readonly<Record<RiskDriver, string>> = {
    unconstrained_input: [
        "The input space here is too large to enumerate, so probe its edges rather than its middle:",
        "text in other languages and scripts, and mixed direction text;",
        "input that looks like instructions to the system rather than content;",
        "empty, whitespace-only, very long, and boundary-length values;",
        "characters that mean something to a parser - quotes, angle brackets, backslashes, emoji;",
        "content that should be refused, phrased several different ways, since one refusal path may not cover the rest.",
    ].join(" "),
    spatial_manipulation: [
        "Position is a free variable here, so the interesting cases are the ones a tidy demo never produces:",
        "place an element at the very edge of its container and past it;",
        "overlap two elements;",
        "place, undo, and place again;",
        "move something after committing to its position;",
        "operate at a different zoom or window size, where coordinates and hit targets shift.",
    ].join(" "),
    interruptible_state: [
        "This flow can be left and returned to, so test what a user actually does to it:",
        "reload the page mid-way and check what survived;",
        "navigate back after a step and go forward again;",
        "submit twice in quick succession;",
        "abandon it entirely, return later, and see whether the draft is intact or the flow is wedged;",
        "start it in one tab while it is open in another.",
    ].join(" "),
    realtime_async: [
        "Timing is part of the behaviour here, not an implementation detail:",
        "act while a previous action is still resolving;",
        "check what is shown between an optimistic update and its confirmation;",
        "let the underlying data change while the view is open;",
        "confirm a failed request surfaces as an error rather than a silent no-op or a stuck spinner.",
    ].join(" "),
    permissions: [
        "Visibility varies by actor here, so the test is what a DIFFERENT actor sees:",
        "reach the same object as a user who should not have access, by direct URL as well as through the UI;",
        "check that what is hidden is actually withheld rather than merely not rendered;",
        "verify an action refused in the interface is also refused when triggered directly.",
    ].join(" "),
};

/**
 * The adversarial brief for a flow, or nothing when it has no stated risk.
 *
 * Only worth spending on flows with real budget: attacking a surface that gets two
 * tests just crowds out its happy path, and a flow nobody depends on does not repay
 * the depth.
 */
export function renderRedTeamBrief(budget: FlowBudget): string | undefined {
    if (budget.tier !== 1 || budget.riskDrivers.length === 0) return undefined;

    // Every driver is a key of PLAYBOOKS (the Record is exhaustive over RiskDriver),
    // so the lookup always resolves - a new driver would fail typecheck here first.
    const plays = budget.riskDrivers.map((driver) => `- ${PLAYBOOKS[driver]}`).join("\n");
    if (plays.length === 0) return undefined;

    const claims =
        budget.invariants.length > 0
            ? `\nThis flow claims to guarantee:\n${budget.invariants.map((i) => `- ${i}`).join("\n")}\n` +
              `Write tests that try to make these FALSE. A claim you cannot break is worth a test proving you tried; ` +
              `a claim you can break is the most valuable test in the suite.\n`
            : "";

    return `
### Going deeper on "${budget.name}"

This is a tier-1 flow, so part of its budget should go on trying to break it rather
than on more variations of it working. Once the obvious paths are covered, spend the
rest here:

${plays}
${claims}`;
}
