import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useAPIMutation } from "lib/query/api-queries";
import { type RouterOutputs, trpc } from "lib/trpc";

export type SecretSummary = RouterOutputs["secrets"]["list"][number];

export function useSecrets(applicationId: string, appName: string) {
    return useSuspenseQuery(trpc.secrets.list.queryOptions({ applicationId, appName }));
}

export function useUpsertSecrets(applicationId: string, appName: string) {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.secrets.upsert.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.secrets.list.queryKey({ applicationId, appName }),
                });
            },
        }),
        successToast: (_data, variables) => {
            const count = variables.items.length;
            if (count === 1) {
                const key = variables.items[0]?.key;
                return { title: "Secret saved", description: key };
            }
            return { title: `${count} secrets saved` };
        },
    });
}

export function useDeleteSecret(applicationId: string, appName: string) {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.secrets.delete.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({
                    queryKey: trpc.secrets.list.queryKey({ applicationId, appName }),
                });
            },
        }),
        successToast: (_data, variables) => ({ title: "Secret deleted", description: variables.key }),
    });
}

export interface SecretItemInput {
    key: string;
    value: string;
}
