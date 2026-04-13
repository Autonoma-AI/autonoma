export const TaskQueue = {
    WEB: "web",
    MOBILE: "mobile",
    GENERAL: "general",
} as const;

export type TaskQueue = (typeof TaskQueue)[keyof typeof TaskQueue];
