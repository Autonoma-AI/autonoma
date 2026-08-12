import type { LIVE_STEP } from "@autonoma/types";
import type { OnboardingStep } from "./generated/prisma/client";

/**
 * Compile-time proof that `LIVE_STEP` is still a member of the Prisma `OnboardingStep` enum.
 *
 * `@autonoma/types` copies exactly one value out of that enum, because `apps/ui` asks "has
 * this application gone live?" and must not pull in a Prisma client to do it. This file is
 * where that single denormalization is kept honest: it lives in the one package that can see
 * both, so renaming or removing `completed` in `schema.prisma` fails `tsc --noEmit` here
 * instead of leaving a predicate that silently answers `false` for every application.
 *
 * Nothing imports this at runtime - the file exists to be typechecked. The constraint is what
 * does the work; a bare type alias would assert nothing.
 */
type MustBeAnOnboardingStep<T extends OnboardingStep> = T;

export type LiveStepIsAnOnboardingStep = MustBeAnOnboardingStep<typeof LIVE_STEP>;
