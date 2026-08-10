import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";

export function useBillingStatus() {
    return useSuspenseQuery(trpc.billing.status.queryOptions());
}

/**
 * Whether this account would get free starting credits in a new organization, and which organizations
 * spent that entitlement if not. Keyed on the person, not the active organization.
 *
 * `useQuery` rather than `useSuspenseQuery`: this only decorates a screen with an explanation, so it
 * must never hold one up or fail one.
 */
export function useFreeStartEligibility() {
    return useQuery(trpc.billing.freeStartEligibility.queryOptions());
}

/**
 * The organization's credit balance, or undefined until it resolves.
 *
 * Plain `useQuery`, not the suspense one above: callers use this to decide whether to offer an action,
 * and suspending an onboarding screen on that decision would blank a working page.
 */
export function useCreditBalance(): number | undefined {
    const { data } = useQuery(trpc.billing.status.queryOptions());
    return data?.creditBalance;
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
