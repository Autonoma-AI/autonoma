import type { AgentIndicatorState } from "@autonoma/blacklight";
import { useQuery } from "@tanstack/react-query";
import { useParams, useRouteContext } from "@tanstack/react-router";
import { trpc } from "lib/trpc";
import { useCallback, useEffect, useRef, useState } from "react";

export interface ActivityLine {
    type: "generation" | "review";
    count: number;
    label: string;
    colorClass: string;
    href?: string;
}

export interface BranchActivity {
    state: AgentIndicatorState;
    activities: ActivityLine[];
}

const IDLE_ACTIVITY: BranchActivity = { state: "idle", activities: [] };

const SUCCESS_DECAY_MS = 10_000;

function useAppContext() {
    const params = useParams({ strict: false }) as { appSlug?: string };
    const applications = useRouteContext({ from: "/_blacklight/_app-shell", select: (ctx) => ctx.applications });

    if (params.appSlug == null) return undefined;

    const app = applications.find((a) => a.slug === params.appSlug);
    if (app == null) return undefined;

    return { appSlug: params.appSlug, branchName: app.mainBranch.name, applicationId: app.id };
}

function hasIncompleteGenerations(generationSummary: Array<{ status: string }>): boolean {
    return generationSummary.some((g) => g.status === "pending" || g.status === "queued" || g.status === "running");
}

export function useBranchActivity(): BranchActivity {
    const ctx = useAppContext();

    const { data: branch } = useQuery({
        ...trpc.branches.detailByName.queryOptions({
            applicationId: ctx?.applicationId ?? "",
            branchName: ctx?.branchName ?? "",
        }),
        enabled: ctx != null,
    });

    const branchId = branch?.id;
    const pendingSnapshotId = branch?.pendingSnapshotId;

    const { data: editSession } = useQuery({
        ...trpc.snapshotEdit.get.queryOptions({ branchId: branchId ?? "" }),
        enabled: branchId != null && pendingSnapshotId != null,
        refetchInterval: (query) => {
            const data = query.state.data;
            if (data == null) return false;
            return hasIncompleteGenerations(data.generationSummary) ? 5000 : false;
        },
    });

    const [showSuccess, setShowSuccess] = useState(false);
    const successTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const computeActivity = useCallback((): BranchActivity => {
        if (ctx == null) return IDLE_ACTIVITY;

        const activities: ActivityLine[] = [];
        const base = `/app/${ctx.appSlug}`;

        if (editSession != null) {
            const activeGens = editSession.generationSummary.filter(
                (g) => g.status === "queued" || g.status === "running",
            );
            const pendingGens = editSession.generationSummary.filter((g) => g.status === "pending");
            const totalActive = activeGens.length + pendingGens.length;
            if (totalActive > 0) {
                activities.push({
                    type: "generation",
                    count: totalActive,
                    label: `Running ${totalActive} generation${totalActive !== 1 ? "s" : ""}...`,
                    colorClass: "text-lime-400",
                    href: `${base}/generation-progress`,
                });
            }
        }

        const hasGenerations = activities.some((a) => a.type === "generation");
        const state: AgentIndicatorState = hasGenerations ? "working" : "idle";

        return { state, activities };
    }, [ctx, editSession]);

    const activity = computeActivity();

    // Success decay: when we go from active to idle, briefly show success
    const prevStateRef = useRef(activity.state);
    useEffect(() => {
        const prev = prevStateRef.current;
        prevStateRef.current = activity.state;

        if ((prev === "working" || prev === "processing") && activity.state === "idle") {
            setShowSuccess(true);
            clearTimeout(successTimer.current);
            successTimer.current = setTimeout(() => setShowSuccess(false), SUCCESS_DECAY_MS);
        }

        return () => clearTimeout(successTimer.current);
    }, [activity.state]);

    if (showSuccess && activity.state === "idle") {
        return { state: "success", activities: [] };
    }

    return activity;
}
