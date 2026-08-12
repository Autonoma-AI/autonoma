/**
 * The step an application reaches when it goes live.
 *
 * "Live" means the preview environment is up and Autonoma has started reviewing pull
 * requests. It does NOT mean setup is finished: the SDK handler, the scenario recipes and
 * the test suite are separate work that carries on afterwards, tracked by `dryRunPassedAt`
 * and the uploaded artifacts rather than by this step. Do not read it as "onboarding is
 * done" - read it as "we may now act on this customer's repository".
 *
 * Mirrors `OnboardingStep.completed` in `packages/db/prisma/schema.prisma`. It is the ONE
 * value copied out of that enum, and `packages/db/src/onboarding-step-parity.ts` asserts at
 * compile time that it is still a member.
 */
export const LIVE_STEP = "completed";

/**
 * Whether an application has gone live, and so whether Autonoma may act on its pull
 * requests. This is the ONE way to ask.
 *
 * Do not write `step === "completed"` at a call site. The question is asked from five
 * packages and used to be spelled four different ways, one of which
 * (`isStepAtOrPast(step, "completed")`) agreed with the others only for as long as
 * `completed` stayed last in the step order.
 *
 * Fails closed. An absent step - an application with no onboarding row - is not live, so
 * anything that writes to a customer's repository stays quiet when in doubt. A caller that
 * genuinely wants the opposite (the app hub, which lists row-less legacy applications as
 * usable) must say so at its own call site rather than passing the question through here.
 *
 * Takes a `string` rather than the step union deliberately. The union is the Prisma enum,
 * and `apps/ui` asks this question too but must never import a Prisma client - it receives
 * the literal union through tRPC inference instead. Re-declaring the members here to type
 * this parameter would be a hand-maintained copy of a generated enum, which a rename would
 * silently break. Ordering questions, which DO need the union, live in
 * `apps/api/src/routes/onboarding/onboarding-step-order.ts` where the real enum is visible.
 */
export function hasGoneLive(step: string | null | undefined): boolean {
    return step === LIVE_STEP;
}
