import type { RouterOutputs } from "lib/trpc";

export type SdkDryRunTargets = RouterOutputs["onboarding"]["listSdkDryRunTargets"];
export type SdkDryRunTarget = SdkDryRunTargets["targets"][number];
export type TargetAvailability = SdkDryRunTarget["availability"];

export interface SelectableTarget {
    id: string;
    kind: "main" | "pr";
    label: string;
    prNumber?: number;
    isAutoDetected: boolean;
    availability: TargetAvailability;
}

/**
 * The PreviewKit env addressing (owner/repo/pr) for streaming a managed target's
 * logs. Only PreviewKit-managed targets carry a `repoFullName`; external (BYO)
 * targets have no preview env we can stream, so they resolve to undefined.
 */
export function buildPreviewLogTarget(
    target: { source: string; repoFullName?: string; prNumber?: number; sdkAppName?: string } | undefined,
): { owner: string; repo: string; pr: number; app?: string } | undefined {
    if (target?.source !== "previewkit" || target.repoFullName == null || target.prNumber == null) return undefined;
    const [owner = "", repo = ""] = target.repoFullName.split("/");
    if (owner === "" || repo === "") return undefined;
    return { owner, repo, pr: target.prNumber, app: target.sdkAppName };
}

export function buildPullRequestUrl(
    target: { source: string; repoFullName?: string; prNumber?: number } | undefined,
): string | undefined {
    if (target?.source !== "previewkit" || target.repoFullName == null || target.prNumber == null) return undefined;
    if (target.prNumber <= 0) return undefined;
    return `https://github.com/${target.repoFullName}/pull/${target.prNumber}`;
}

/**
 * Display label for a validation / dry-run target: "main" for the main env, and
 * "<name> #<pr>" for a PR (with a "(SDK PR)" marker on the auto-detected one).
 * Guards against a doubled number when the name is already the "PR #n" fallback.
 */
export function formatTargetLabel(target: {
    kind: "main" | "pr";
    label: string;
    prNumber?: number;
    isAutoDetected: boolean;
}): string {
    if (target.kind === "main") return target.label;
    const base =
        target.prNumber != null && !target.label.includes(`#${target.prNumber}`)
            ? `${target.label} #${target.prNumber}`
            : target.label;
    return target.isAutoDetected ? `${base} (SDK PR)` : base;
}

/** Short state note rendered next to non-ready targets in the selectors. */
export function targetAvailabilityNote(availability: TargetAvailability): string | undefined {
    if (availability === "building") return "building...";
    if (availability === "failed") return "deploy failed";
    if (availability === "no_preview") return "no preview";
    return undefined;
}

/**
 * Dry runs can only hit deployed previews, so the default pick is the first
 * READY target in preference order: auto-detected SDK PR, main, anything else.
 */
export function pickInitialDryRunTargetId(targets: {
    targets: Array<{ id: string; kind: "main" | "pr"; availability: TargetAvailability }>;
    autoDetectedTargetId?: string;
}): string | undefined {
    const ready = targets.targets.filter((t) => t.availability === "ready");
    const autoDetected = ready.find((t) => t.id === targets.autoDetectedTargetId);
    return autoDetected?.id ?? ready.find((t) => t.kind === "main")?.id ?? ready[0]?.id;
}

/**
 * The dry-run target for a step: the URL-pinned target when it still exists,
 * otherwise the auto-detected SDK PR, otherwise the first ready preview. A pinned
 * target that has since gone (PR closed, preview torn down) is no longer in the
 * list, so it falls back cleanly instead of selecting nothing.
 */
export function resolveTargetId(pinnedTargetId: string | undefined, targets: SdkDryRunTargets): string | undefined {
    if (pinnedTargetId != null && targets.targets.some((t) => t.id === pinnedTargetId)) return pinnedTargetId;
    return targets.autoDetectedTargetId ?? pickInitialDryRunTargetId(targets);
}

/** Every whitespace-separated token must appear in the label or "#<pr>". */
export function matchesTargetQuery(target: SelectableTarget, query: string): boolean {
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "") return true;
    const haystack = `${formatTargetLabel(target)} #${target.prNumber ?? ""}`.toLowerCase();
    return trimmed.split(/\s+/).every((token) => haystack.includes(token));
}
