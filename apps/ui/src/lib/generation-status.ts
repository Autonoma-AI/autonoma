import type { RouterOutputs } from "lib/trpc";

export type Generation = RouterOutputs["generations"]["list"][number];

export function toGenerationBadgeVariant(status: Generation["status"]) {
    switch (status) {
        case "success":
            return "success" as const;
        case "failed":
            return "critical" as const;
        case "running":
            return "status-running" as const;
        case "queued":
            return "status-pending" as const;
        case "pending":
            return "status-pending" as const;
    }
}

export function toGenerationStatusLabel(status: Generation["status"]) {
    switch (status) {
        case "success":
            return "Passed";
        case "failed":
            return "Failed";
        case "running":
            return "Running";
        case "queued":
            return "Queued";
        case "pending":
            return "Pending";
    }
}
