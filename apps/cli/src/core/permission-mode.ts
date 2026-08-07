import * as p from "../ui/prompts";
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODE_LABELS, type PermissionMode } from "./coding-agent";

/**
 * The autonomy answer for this run.
 *
 * A run hands the terminal to a coding agent up to three times - the preview
 * phase, the recipe handoff, the SDK repair - and each site used to put the same
 * question to the user, so a single run asked it two or three times. The question
 * is about the run, not about the individual handoff, so the first answer stands
 * for all of them.
 *
 * A leaf module holding one process-scoped value, the same shape as `run-id.ts`:
 * one CLI invocation is one run.
 */
let runPermissionMode: PermissionMode | undefined;

export interface PermissionModeRequest {
    /** `--permission-mode`, which answers the question outright and outranks everything. */
    preset?: PermissionMode;
    /** A mode a resumed run already recorded, so continuing a run does not re-ask. */
    remembered?: PermissionMode;
    /** Headless runs have nobody to ask. */
    interactive: boolean;
}

/**
 * The autonomy to launch a coding agent with, asking at most once per run.
 *
 * Resolution order is most-explicit-first: the flag, then whatever this run has
 * already settled on, then a mode carried over from a resumed run. Only when none
 * of those exist is the user asked, and the answer is kept for the handoffs that
 * follow.
 */
export async function resolvePermissionMode(request: PermissionModeRequest): Promise<PermissionMode> {
    const known = request.preset ?? runPermissionMode ?? request.remembered;
    if (known != null) {
        runPermissionMode = known;
        return known;
    }
    if (!request.interactive) return DEFAULT_PERMISSION_MODE;

    const selected = await p.select<PermissionMode>({
        message: "How much autonomy should the agent have?",
        options: [
            { value: "bypassPermissions", label: PERMISSION_MODE_LABELS.bypassPermissions },
            { value: "acceptEdits", label: PERMISSION_MODE_LABELS.acceptEdits },
            { value: "default", label: PERMISSION_MODE_LABELS.default },
        ],
        initialValue: DEFAULT_PERMISSION_MODE,
    });
    if (p.isCancel(selected)) throw new Error("Permission mode selection cancelled");
    runPermissionMode = selected;
    return selected;
}
