import type { ZeroStateStep } from "@autonoma/blacklight";

/** `suiteHealthFooter` imports this, so the sidebar meter and the page panels cannot word the same state twice. */
export const WAITING_FOR_FIRST_PULL_REQUEST = "Waiting for your first pull request";

export const ZERO_SURFACES = [
    "main_problems_rail",
    "main_checkpoints",
    "tests_tree",
    "scenarios_endpoint",
    "pr_checkpoints",
] as const;

export type ZeroSurface = (typeof ZERO_SURFACES)[number];

interface ZeroCopy {
    eyebrow?: string;
    title: string;
    description?: string;
    steps?: ZeroStateStep[];
}

interface EmptyCopy {
    title: string;
    description?: string;
}

interface SurfaceCopy {
    /** Nothing has EVER happened here. Names what starts it. */
    zero: ZeroCopy;
    /** It has happened before and there is nothing right now. States the count, asks for nothing. */
    empty: EmptyCopy;
}

/** The two readings of one container live next to each other so they cannot drift apart. */
export const SURFACE_COPY: Record<ZeroSurface, SurfaceCopy> = {
    main_problems_rail: {
        zero: {
            title: "Nothing has been checked yet.",
            description: "It lists what the agent found on main and could not explain away, most severe first.",
        },
        empty: { title: "No unresolved problems" },
    },

    main_checkpoints: {
        zero: {
            title: "Main has never been checked.",
            description:
                "Checkpoints are recorded when the agent runs against a commit. Main gets one when a pull request merges, and one whenever you ask for a run on main.",
        },
        empty: {
            title: "No checkpoints on main yet.",
            description:
                "Runs so far have all been on pull-request branches. Main gets a checkpoint when one of them merges.",
        },
    },

    tests_tree: {
        // Not activity-gated: a fully set-up application always has tests, so an empty tree means they were
        // deleted rather than never generated. Both readings are therefore about content, not about history.
        zero: {
            title: "This suite has no tests.",
            description:
                "The planner writes your suite by reading your codebase. Run it again to regenerate it, or add a folder and write one by hand.",
        },
        empty: { title: "This suite has no tests." },
    },

    scenarios_endpoint: {
        zero: {
            title: "No Environment Factory endpoint configured.",
            description:
                "Scenarios are the test data each run starts from. Autonoma discovers them by calling one endpoint in your backend.",
            steps: [
                { label: "Add the SDK endpoint to your application." },
                { label: "Point Autonoma at its URL and signing secret." },
                { label: "Autonoma discovers your scenarios and seeds fresh data before every run." },
            ],
        },
        empty: {
            title: "No scenarios discovered yet.",
            description: "Autonoma calls your endpoint and lists what it returns.",
        },
    },

    pr_checkpoints: {
        zero: {
            title: "No run has finished for this pull request yet.",
            description: "The verdict is posted as a comment on the pull request when it does.",
        },
        empty: { title: "No findings were recorded for this checkpoint." },
    },
};

export function surfaceCopy(surface: ZeroSurface, hasEverHappened: boolean): ZeroCopy | EmptyCopy {
    const copy = SURFACE_COPY[surface];
    return hasEverHappened ? copy.empty : copy.zero;
}
