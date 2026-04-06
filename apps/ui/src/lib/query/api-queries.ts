import { type DefaultError, type UseMutationOptions, useMutation } from "@tanstack/react-query";
import type { EnsureQueryDataOptions, QueryClient, QueryKey } from "@tanstack/react-query";
import { notFound } from "@tanstack/react-router";
import { isTRPCClientError } from "@trpc/client";
import { toastManager } from "lib/toast-manager";
import type { ReactNode } from "react";

export interface APIToastProps {
    title?: ReactNode;
    description?: ReactNode;
}

export interface APIMutationOptions<
    TData = unknown,
    TError = DefaultError,
    TVariables = void,
    TOnMutateResult = unknown,
> extends UseMutationOptions<TData, TError, TVariables, TOnMutateResult> {
    /**
     * A success toast to show when the mutation succeeds.
     * Can be a static object or a function that returns one based on the mutation result and variables.
     *
     * If not provided, no toast will be shown on success.
     */
    successToast?: APIToastProps | ((data: TData, variables: TVariables) => APIToastProps);

    /**
     * An error toast to show when the mutation fails.
     * Can be a static object or a function that returns one based on the error and variables.
     *
     * If not provided, a default error toast will be shown on failure.
     */
    errorToast?: APIToastProps | ((error: TError, variables: TVariables) => APIToastProps);
}

const DEFAULT_ERROR_TITLE = "An unexpected error occurred";

const INTERNAL_ERROR_PATTERNS = [/prisma/i, /invocation in/i, /constraint/i, /\.ts:\d+/];

function extractErrorMessage(error: unknown): string | undefined {
    const message = isTRPCClientError(error) ? error.message : error instanceof Error ? error.message : undefined;
    if (message == null) return undefined;
    if (INTERNAL_ERROR_PATTERNS.some((p) => p.test(message))) return "Something went wrong. Please try again.";
    return message;
}

export function useAPIMutation<TData = unknown, TError = DefaultError, TVariables = void, TOnMutateResult = unknown>(
    options: APIMutationOptions<TData, TError, TVariables, TOnMutateResult>,
) {
    const { successToast, errorToast, onSuccess, onError, ...mutationOptions } = options;

    return useMutation({
        ...mutationOptions,
        onSuccess: (...args) => {
            const [data, variables] = args;
            const props = typeof successToast === "function" ? successToast(data, variables) : successToast;

            if (props != null) {
                toastManager.add({
                    title: String(props.title ?? ""),
                    description: props.description != null ? String(props.description) : undefined,
                    type: "success",
                });
            }

            return onSuccess?.(...args);
        },
        onError: (...args) => {
            const [error, variables] = args;
            const props =
                typeof errorToast === "function"
                    ? errorToast(error, variables)
                    : (errorToast ?? { title: DEFAULT_ERROR_TITLE });

            const description = props.description != null ? String(props.description) : extractErrorMessage(error);
            toastManager.add({
                title: String(props.title ?? ""),
                description,
                type: "critical",
            });

            return onError?.(...args);
        },
    });
}

/**
 * Wrapper around the `queryClient.ensureQueryData` method that converts 404 errors to `notFound` responses for Tanstack Router.
 */
export async function ensureAPIQueryData<
    TQueryFnData,
    TError = DefaultError,
    TData = TQueryFnData,
    TQueryKey extends QueryKey = QueryKey,
>(queryClient: QueryClient, options: EnsureQueryDataOptions<TQueryFnData, TError, TData, TQueryKey>): Promise<TData> {
    try {
        return await queryClient.ensureQueryData(options);
    } catch (error) {
        if (isTRPCClientError(error) && error.data?.httpStatus === 404) throw notFound();

        // TODO: handle unauthorized errors (401) by redirecting to login page

        throw error;
    }
}
