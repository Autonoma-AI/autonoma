const ACTIONS: Record<string, { label: string; colorClass: string }> = {
    DISCOVER: { label: "Discover", colorClass: "text-purple-400" },
    UP: { label: "Up", colorClass: "text-emerald-400" },
    DOWN: { label: "Down", colorClass: "text-amber-400" },
};

export function toActionLabel(action: string): string {
    return ACTIONS[action]?.label ?? action;
}

export function toActionColor(action: string): string {
    return ACTIONS[action]?.colorClass ?? "text-text-secondary";
}
