import type { AppRouter } from "@autonoma/api/router";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import type { inferRouterOutputs } from "@trpc/server";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

type EditSession = inferRouterOutputs<AppRouter>["snapshotEdit"]["get"];
type SuiteRun = EditSession["runs"][number];

const SESSION_POLL_MS = 5000;

/** A run of one test, carrying the test's name so a card can render without joining the suite itself. */
export interface NamedRun extends SuiteRun {
    testCaseName: string;
}

/** A test the session changed and has not run yet - what the editor offers to run. */
export interface TestAwaitingRun {
    testCaseId: string;
    testCaseName: string;
}

function selectEditSession(session: EditSession) {
    const testCaseNames = new Map(session.testSuite.testCases.map((tc) => [tc.id, tc.name]));
    const nameOf = (testCaseId: string) => testCaseNames.get(testCaseId) ?? "Unknown";

    const runs: NamedRun[] = session.runs.map((run) => ({ ...run, testCaseName: nameOf(run.testCaseId) }));
    const testsAwaitingRun: TestAwaitingRun[] = session.testsAwaitingRun.map((testCaseId) => ({
        testCaseId,
        testCaseName: nameOf(testCaseId),
    }));

    return {
        ...session,
        runs,
        testsAwaitingRun,
        activeRuns: runs.filter((run) => isRunInFlight(run.status)),
        finishedRuns: runs.filter((run) => !isRunInFlight(run.status)),
    };
}

function isRunInFlight(status: SuiteRun["status"]): boolean {
    return status === "pending" || status === "queued" || status === "running";
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
            state.data == null || state.data.runs.some((run) => isRunInFlight(run.status)) ? SESSION_POLL_MS : false,
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

/** Start a run of each listed test. The only way the editor runs anything - editing a test never starts one. */
export function useStartRuns() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.snapshotEdit.startRuns.mutationOptions({
            onSettled: (_data, _error, variables) => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.snapshotEdit.get.queryKey({ snapshotId: variables.snapshotId }),
                });
            },
        }),
        successToast: { title: "Tests queued to run" },
        errorToast: { title: "Failed to start the runs" },
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
