/**
 * The onboarding gate every PR-facing write asks before it touches a customer's repository:
 * a half-onboarded app has no meaningful results to report, and commenting early is just
 * noise on their pull requests.
 *
 * The predicate itself lives in `@autonoma/types` because the same question is asked from
 * the browser, which cannot import a Prisma enum. It is re-exported here so this package's
 * consumers keep importing it from `@autonoma/github/comment`, next to the comment writers
 * it guards.
 */
export { hasGoneLive } from "@autonoma/types";
