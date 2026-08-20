import type { ApplicationActivity } from "@autonoma/types";
import { type QueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";

export function useApplicationActivity(): ApplicationActivity {
    const app = useCurrentApplication();
    const { data } = useSuspenseQuery(trpc.applications.activity.queryOptions({ applicationId: app.id }));
    return data;
}

export function useApplicationActivityFor(applicationId: string): ApplicationActivity {
    const { data } = useSuspenseQuery(trpc.applications.activity.queryOptions({ applicationId }));
    return data;
}

export async function ensureApplicationActivityData(queryClient: QueryClient, applicationId: string) {
    return await ensureAPIQueryData(queryClient, trpc.applications.activity.queryOptions({ applicationId }));
}
