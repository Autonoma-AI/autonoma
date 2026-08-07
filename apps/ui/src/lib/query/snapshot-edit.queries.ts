import type { AppRouter } from "@autonoma/api/router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

type GenerationSummary = inferRouterOutputs<AppRouter>["snapshotEdit"]["get"]["generationSummary"][number];

const SESSION_POLL_MS = 5000;

export interface EnrichedGeneration {
    testCaseId: string;
    generationId: string;
    status: GenerationSummary["status"];
    testCaseName: string;
}

function selectEditSession(session: inferRouterOutputs<AppRouter>["snapshotEdit"]["get"]) {
    const { generationSummary, changes } = session;

    const changedTestCaseIds = new Set(
        changes.filter((c) => c.type === "added" || c.type === "updated").map((c) => c.testCaseId),
    );
    const generatedTestCaseIds = new Set(
        generationSummary.filter((g) => g.status !== "failed").map((g) => g.testCaseId),
    );
    const pendingGenerationCount = [...changedTestCaseIds].filter((id) => !generatedTestCaseIds.has(id)).length;

    const testCaseNames = new Map(session.testSuite.testCases.map((tc) => [tc.id, tc.name]));
    const enriched = generationSummary.map((g) => ({
        ...g,
        testCaseName: testCaseNames.get(g.testCaseId) ?? "Unknown",
    }));

    const pendingGenerations = enriched.filter((g) => g.status === "pending");
    const activeGenerations = enriched.filter((g) => g.status === "queued" || g.status === "running");
    const completedGenerations = enriched.filter((g) => g.status === "success" || g.status === "failed");

    const hasIncompleteGenerations = pendingGenerations.length > 0 || activeGenerations.length > 0;

    return {
        ...session,
        hasIncompleteGenerations,
        pendingGenerationCount,
        pendingGenerations,
        activeGenerations,
        completedGenerations,
    };
}

function hasIncompleteGenerations(generationSummary: GenerationSummary[]): boolean {
    return generationSummary.some((g) => g.status === "pending" || g.status === "queued" || g.status === "running");
}

/**
 * Which snapshot, if any, the editor may address on this branch. Polled so that a session superseded by a new
 * commit's analysis stops rendering the editor instead of failing on its next write.
 */
export function useEditSessionState(branchId: string) {
    return useSuspenseQuery({
        ...trpc.snapshotEdit.state.queryOptions({ branchId }),
        refetchInterval: SESSION_POLL_MS,
    });
}

export function useEditSession(snapshotId: string) {
    return useSuspenseQuery({
        ...trpc.snapshotEdit.get.queryOptions({ snapshotId }),
        select: selectEditSession,
        refetchInterval: ({ state }) =>
            state.data == null || hasIncompleteGenerations(state.data.generationSummary) ? SESSION_POLL_MS : false,
    });
}

export function useStartEditSession() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.snapshotEdit.start.mutationOptions({
            onSettled: (_data, _error, variables) => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.snapshotEdit.state.queryKey({ branchId: variables.branchId }),
                });
                void queryClient.invalidateQueries({ queryKey: trpc.branches.detailByName.queryKey() });
            },
        }),
        errorToast: { title: "Failed to start edit session" },
    });
}

export function useAddTestToEdit() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.snapshotEdit.addTest.mutationOptions({
            onSettled: (_data, _error, variables) => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.snapshotEdit.get.queryKey({ snapshotId: variables.snapshotId }),
                });
            },
        }),
        successToast: { title: "Test added" },
        errorToast: { title: "Failed to add test" },
    });
}

export function useAddTestsToEdit() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.snapshotEdit.addTests.mutationOptions({
            onSettled: (_data, _error, variables) => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.snapshotEdit.get.queryKey({ snapshotId: variables.snapshotId }),
                });
            },
        }),
        successToast: { title: "Tests added" },
        errorToast: { title: "Failed to add tests" },
    });
}

export function useUpdateTestInEdit() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.snapshotEdit.updateTest.mutationOptions({
            onSettled: (_data, _error, variables) => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.snapshotEdit.get.queryKey({ snapshotId: variables.snapshotId }),
                });
            },
        }),
        successToast: { title: "Test updated" },
        errorToast: { title: "Failed to update test" },
    });
}

export function useRemoveTestFromEdit() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.snapshotEdit.removeTest.mutationOptions({
            onSettled: (_data, _error, variables) => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.snapshotEdit.get.queryKey({ snapshotId: variables.snapshotId }),
                });
            },
        }),
        successToast: { title: "Test removed" },
        errorToast: { title: "Failed to remove test" },
    });
}

export function useRegenerateSteps() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.snapshotEdit.regenerateSteps.mutationOptions({
            onSettled: (_data, _error, variables) => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.snapshotEdit.get.queryKey({ snapshotId: variables.snapshotId }),
                });
            },
        }),
        successToast: { title: "Steps regeneration scheduled" },
        errorToast: { title: "Failed to regenerate steps" },
    });
}

export function useDiscardChange() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.snapshotEdit.discardChange.mutationOptions({
            onSettled: (_data, _error, variables) => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.snapshotEdit.get.queryKey({ snapshotId: variables.snapshotId }),
                });
            },
        }),
        successToast: { title: "Change discarded" },
        errorToast: { title: "Failed to discard change" },
    });
}

export function useDiscardGeneration() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.snapshotEdit.discardGeneration.mutationOptions({
            onSettled: (_data, _error, variables) => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.snapshotEdit.get.queryKey({ snapshotId: variables.snapshotId }),
                });
            },
        }),
        successToast: { title: "Generation discarded" },
        errorToast: { title: "Failed to discard generation" },
    });
}

export function useQueueGenerations() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.snapshotEdit.queueGenerations.mutationOptions({
            onSettled: (_data, _error, variables) => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.snapshotEdit.get.queryKey({ snapshotId: variables.snapshotId }),
                });
            },
        }),
        successToast: { title: "Generations queued" },
        errorToast: { title: "Failed to queue generations" },
    });
}

export function useFinalizeEdit() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.snapshotEdit.finalize.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.branches.detailByName.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.snapshotEdit.get.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.snapshotEdit.state.queryKey() });
            },
        }),
        successToast: { title: "Changes saved" },
        errorToast: { title: "Failed to save changes" },
    });
}

export function useDiscardEdit() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.snapshotEdit.discard.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.branches.detailByName.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.snapshotEdit.get.queryKey() });
                void queryClient.invalidateQueries({ queryKey: trpc.snapshotEdit.state.queryKey() });
            },
        }),
        successToast: { title: "Changes discarded" },
        errorToast: { title: "Failed to discard changes" },
    });
}
