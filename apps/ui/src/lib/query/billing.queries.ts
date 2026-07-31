import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

export function useBillingStatus() {
    return useSuspenseQuery(trpc.billing.status.queryOptions());
}

export type BillingStatusData = ReturnType<typeof useBillingStatus>["data"];
export type BillingTransaction = BillingStatusData["transactions"][number];

export function useCreateCheckoutSession() {
    return useAPIMutation({
        ...trpc.billing.createCheckoutSession.mutationOptions(),
    });
}

export function useCreatePortalSession() {
    return useAPIMutation({
        ...trpc.billing.createPortalSession.mutationOptions(),
    });
}

export function useUpdateAutoTopUp() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.billing.updateAutoTopUp.mutationOptions({
            onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.billing.status.queryKey() });
            },
        }),
        successToast: { title: "Auto top-up settings updated" },
    });
}

export function useRedeemPromoCode() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.billing.redeemPromoCode.mutationOptions({
            onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.billing.status.queryKey() });
            },
        }),
        successToast: { title: "Promo code redeemed" },
    });
}

export function useVercelOverageStatus() {
    return useSuspenseQuery(trpc.billing.getVercelOverageStatus.queryOptions());
}

export function useUpdateVercelOverageCap() {
    const queryClient = useQueryClient();
    return useAPIMutation({
        ...trpc.billing.updateVercelOverageCap.mutationOptions({
            onSuccess: () => {
                void queryClient.invalidateQueries({ queryKey: trpc.billing.getVercelOverageStatus.queryKey() });
            },
        }),
        successToast: { title: "Usage cap updated" },
    });
}
