/**
 * The onboarding flow, declared once.
 *
 * Every screen is one entry that says everything true of it: which phase of the rail it belongs
 * to, and which backend steps resume there. The step list, the phase rail, and the backend-step
 * mapping are all DERIVED from it below, so adding or retiring a screen is one edit in one place.
 *
 * Derived rather than restated, because separate copies of an ordered list are type-checked for
 * valid members but never for agreeing with each other - two that disagree about where a step
 * resumes both compile, and the disagreement surfaces as a user landing on the wrong screen.
 *
 * These are VIEW steps, not the backend's `OnboardingStep`. Several backend steps collapse onto
 * one screen (`previewkit_deploying` and `preview_verified` both show `deploy-verify`), which is
 * exactly what `backendSteps` records.
 */

/** The phases of the rail, in order. */
const PHASES = [
    { id: "create-app", label: "Create app" },
    { id: "preview", label: "Config previews" },
    { id: "test-data", label: "Test data" },
] as const;

export type OnboardingPhaseId = (typeof PHASES)[number]["id"];

interface OnboardingStepSpec {
    id: string;
    /** The rail entry this screen sits under. `undefined` for `complete`, which is past every phase. */
    phase: OnboardingPhaseId | undefined;
    /** Backend steps that resume at this screen. Empty for a screen the backend never names. */
    backendSteps: readonly string[];
}

/**
 * Legacy backend steps from the SDK/CLI era, which no longer sit on the required path. They
 * resume at the start rather than at a screen that no longer exists.
 */
const LEGACY_BACKEND_STEPS = [
    "install",
    "configure",
    "working",
    "webhook_configuring",
    "discovering",
    "discovered",
    "dry_run_passed",
    "url",
] as const;

const STEPS = [
    // "Add app" merges repo connect + app naming, and is the first required step.
    { id: "add-app", phase: "create-app", backendSteps: ["github", ...LEGACY_BACKEND_STEPS] },
    { id: "preview-environment", phase: "preview", backendSteps: ["preview_environment"] },
    { id: "previewkit-config", phase: "preview", backendSteps: ["previewkit_configuring"] },
    {
        id: "existing-deploys",
        phase: "preview",
        backendSteps: ["existing_deploys_configuring", "existing_deploys_waiting"],
    },
    { id: "deploy-verify", phase: "preview", backendSteps: ["previewkit_deploying", "preview_verified"] },
    // The post-go-live steps, in the order they must be done: the planner upload lands the recipe
    // a dry run provisions from, and the dry run needs an SDK endpoint to call. Ordering is
    // load-bearing, not presentational - `SETUP_STEPS` reads it straight off this list.
    { id: "cli", phase: "test-data", backendSteps: [] },
    { id: "sdk", phase: "test-data", backendSteps: [] },
    { id: "dry-run", phase: "test-data", backendSteps: [] },
    // Belongs to no phase on purpose: it is the screen shown once every phase is behind you, so
    // progress readouts report 100% rather than parking a finished app inside its own last phase.
    // `diff_trigger` is retired - the rows still on it verified a preview, which is now all that
    // live means, so they resume here rather than being sent back to the start.
    { id: "complete", phase: undefined, backendSteps: ["completed", "diff_trigger"] },
] as const satisfies readonly OnboardingStepSpec[];

type OnboardingStepEntry = (typeof STEPS)[number];

export type OnboardingViewStep = OnboardingStepEntry["id"];

export const ONBOARDING_VIEW_STEPS: readonly OnboardingViewStep[] = STEPS.map((step) => step.id);

const ONBOARDING_VIEW_STEP_SET: ReadonlySet<string> = new Set<string>(ONBOARDING_VIEW_STEPS);

export function isOnboardingViewStep(value: string): value is OnboardingViewStep {
    return ONBOARDING_VIEW_STEP_SET.has(value);
}

type SetupStepEntry = Extract<OnboardingStepEntry, { phase: "test-data" }>;

export type SetupStep = SetupStepEntry["id"];

function isSetupStepEntry(step: OnboardingStepEntry): step is SetupStepEntry {
    return step.phase === "test-data";
}

export const SETUP_STEPS: readonly SetupStep[] = STEPS.filter(isSetupStepEntry).map((step) => step.id);

const SETUP_STEP_SET: ReadonlySet<string> = new Set<string>(SETUP_STEPS);

export function isSetupStep(value: string): value is SetupStep {
    return SETUP_STEP_SET.has(value);
}

export interface OnboardingPhase {
    id: OnboardingPhaseId;
    label: string;
    activeSteps: readonly OnboardingViewStep[];
}

/**
 * The user-facing phases, in order, with the screens each covers.
 *
 * Onboarding runs as one flow from connecting a repo to a dry run that provisions real test data,
 * so the phases cover all of it - the post-go-live steps are part of the same journey, not a
 * separate "finish setup" the user opts into afterwards. There is no phase between the preview
 * and the test data: verifying a preview is what takes an app live, so a phase in between could
 * only restate that and wait for a click.
 */
export const ONBOARDING_PHASES: readonly OnboardingPhase[] = PHASES.map((phase) => ({
    id: phase.id,
    label: phase.label,
    activeSteps: STEPS.filter((step) => step.phase === phase.id).map((step) => step.id),
}));

const BACKEND_STEP_ROUTES: ReadonlyMap<string, OnboardingViewStep> = new Map(
    STEPS.flatMap((step) =>
        step.backendSteps.map((backendStep: string): [string, OnboardingViewStep] => [backendStep, step.id]),
    ),
);

/** The screen a backend step resumes at, defaulting to the first step. */
export function resolveStep(step: string | undefined): OnboardingViewStep {
    if (step == null) return "add-app";
    return BACKEND_STEP_ROUTES.get(step) ?? "add-app";
}
