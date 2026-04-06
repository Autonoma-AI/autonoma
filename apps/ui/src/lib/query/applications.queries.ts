import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

export function useCreateApplication() {
    const queryClient = useQueryClient();
    const router = useRouter();
    return useAPIMutation({
        ...trpc.applications.create.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
                // Force the route to re-run beforeLoad so the route context
                // applications array is updated immediately
                void router.invalidate();
            },
        }),
        successToast: { title: "Application created" },
        errorToast: { title: "Failed to create application" },
    });
}

export function useUploadPackage() {
    return useMutation({
        mutationFn: async (file: File): Promise<{ url: string }> => {
            const response = await fetch("/v1/upload/package", {
                method: "PUT",
                headers: {
                    "Content-Type": "application/octet-stream",
                    "x-filename": file.name,
                },
                body: file,
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: "Upload failed" }));
                throw new Error((error as { error: string }).error);
            }

            return response.json() as Promise<{ url: string }>;
        },
    });
}

export function useCreateMinimalApplication() {
    const queryClient = useQueryClient();
    const router = useRouter();
    return useAPIMutation(
        trpc.applications.createMinimal.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
                void router.invalidate();
            },
        }),
    );
}

export function useDeleteApplication() {
    const queryClient = useQueryClient();
    const router = useRouter();
    return useAPIMutation({
        ...trpc.applications.delete.mutationOptions({
            onSettled: async () => {
                await queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
                await router.invalidate();
            },
        }),
        successToast: { title: "Application discarded" },
        errorToast: { title: "Failed to discard application" },
    });
}

export function useUpdateApplicationSettings() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.applications.updateSettings.mutationOptions({
            onSettled: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.applications.list.queryKey() });
            },
        }),
        successToast: { title: "Settings saved" },
        errorToast: { title: "Failed to save settings" },
    });
}
