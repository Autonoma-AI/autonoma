import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { env as baseEnv } from "../env";

/**
 * The reaper deletes namespaces, so `DRY_RUN` is the switch the shell CronJob it
 * replaces carried, and this one keeps: a run that only reports is how a change to
 * the rules gets checked against the live fleet before it is allowed to act.
 */
export const env = createEnv({
    extends: [baseEnv],
    server: {
        PREVIEWKIT_EKS_CLUSTER_NAME: z.string().min(1),
        /**
         * Handed to the loader so it skips `eks:DescribeCluster` - an AWS permission
         * this job's role is not required to hold, and one more thing that can fail
         * before the sweep reaches Kubernetes at all. Same pair the API sets to reach
         * this cluster; see `deployment/previewkit/cluster/api-liveness-rbac.yaml`.
         */
        PREVIEWKIT_EKS_CLUSTER_ENDPOINT: z.url(),
        PREVIEWKIT_EKS_CLUSTER_CA: z.string().min(1),
        AWS_REGION: z.string().min(1).default("us-east-1"),
        DRY_RUN: z
            .enum(["true", "false"])
            .default("false")
            .transform((value) => value === "true"),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
    skipValidation: process.env.TESTING === "true",
});
