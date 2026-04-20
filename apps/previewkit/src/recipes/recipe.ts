import type * as k8s from "@kubernetes/client-node";
import type { ServiceConfig } from "../config/schema";

export interface RecipeResources {
    deployments: k8s.V1Deployment[];
    services: k8s.V1Service[];
    statefulSets: k8s.V1StatefulSet[];
    configMaps: k8s.V1ConfigMap[];
    persistentVolumeClaims: k8s.V1PersistentVolumeClaim[];
}

export interface RecipeConnectionInfo {
    host: string;
    port: number;
}

export interface Recipe {
    readonly name: string;
    generate(config: ServiceConfig, namespace: string): RecipeResources;
    connectionInfo(config: ServiceConfig): RecipeConnectionInfo;
}
