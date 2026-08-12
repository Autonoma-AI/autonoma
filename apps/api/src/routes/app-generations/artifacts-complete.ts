/** Whether each artifact a planner run must produce has landed, plus whether the run itself finished. */
export interface ArtifactSignals {
    setupCompleted: boolean;
    hasRecipe: boolean;
    hasTests: boolean;
    hasKb: boolean;
    hasScenarios: boolean;
}

/**
 * The artifact step is only done when the run completed AND every artifact landed - a run can
 * finish uploading tests/kb/scenarios while the recipe submit silently fails (missing factory,
 * rejected upload). Without the artifact half, the user advances to the SDK step and lands on a
 * dry-run with no scenarios to run.
 *
 * Two callers obtain these signals differently: the detailed status endpoint counts rows so it can
 * render "3 files", while the Finish setup gate only probes existence. They share this predicate so
 * the two can only ever disagree about the signals, never about what completion means.
 */
export function areArtifactsComplete(signals: ArtifactSignals): boolean {
    return signals.setupCompleted && signals.hasRecipe && signals.hasTests && signals.hasKb && signals.hasScenarios;
}
