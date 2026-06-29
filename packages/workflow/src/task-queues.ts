export const TaskQueue = {
    WEB: "web",
    MOBILE: "mobile",
    GENERAL: "general",
    DIFFS: "diffs",
    INVESTIGATION: "investigation",
} as const;

export type TaskQueue = (typeof TaskQueue)[keyof typeof TaskQueue];
