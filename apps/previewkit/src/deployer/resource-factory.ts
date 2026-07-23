import { createHmac } from "node:crypto";
import { isProtectedPreviewkitEnvKey } from "@autonoma/types";
import type * as k8s from "@kubernetes/client-node";
import type { AppConfig } from "../config/schema";

interface AppResourceOptions {
    app: AppConfig;
    namespace: string;
    imageTag: string;
    resolvedEnv: Record<string, string>;
    prNumber: number;
    /** This app's own public preview URL (https://{hash}.{domain}), injected as AUTONOMA_PREVIEWKIT_URL. */
    publicUrl: string;
    awsSecretName?: string;
    /**
     * resourceVersion of the ESO-managed K8s Secret at deploy time. Stamped onto
     * the pod template so a secret change rolls the pods - `envFrom` is captured
     * at pod start, so without this a running pod keeps a stale/missing secret
     * (e.g. AUTONOMA_SHARED_SECRET) until something else restarts it.
     */
    secretVersion?: string;
    /**
     * Commit SHA this deploy built from. `imageTag` is stable per (app, PR) -
     * a new commit overwrites the same ECR tag rather than getting a new one -
     * so without this, a rebuild at an unchanged image string would leave the
     * pod template byte-identical and `kubectl apply` would never roll new
     * pods even though the tag now points at different image content.
     */
    headSha: string;
}

const BASE_LABELS = {
    "previewkit.dev/managed-by": "previewkit",
};

// Label selector matching every previewkit-managed workload (exactly what BASE_LABELS
// stamps on apps + service recipes). The CENTRAL Gatekeeper's TARGET_SELECTOR
// (deployment/previewkit/cluster/gatekeeper/gatekeeper.yaml) must equal this so it
// scales precisely those workloads; the deployer also uses it to sweep the legacy
// per-app Ingresses during migration.
export const MANAGED_SELECTOR = Object.entries(BASE_LABELS)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

// Annotation Gatekeeper reads to wake workloads in dependency order (matches the
// image's default DEPENDS_ON_ANNOTATION). Value is a comma-separated list of the
// workload names this one depends on, so e.g. a web app's database is scaled up
// and ready before the app itself is woken.
export const GATEKEEPER_DEPENDS_ON_ANNOTATION = "gatekeeper.dev/depends-on";

// Per-namespace workload grant for the CENTRAL Gatekeeper's ServiceAccount.
// RBAC cannot scope to label selectors, so its ClusterRole deliberately has no
// workload verbs (deployment/previewkit/cluster/gatekeeper/gatekeeper.yaml);
// instead each handed-over namespace gets this Role + RoleBinding, restoring
// the exact per-namespace least privilege the old in-namespace gatekeeper had.
// The name MUST differ from the legacy "gatekeeper" Role/RoleBinding, which the
// migration script (migrate-existing-previews.sh) deletes - sharing the name
// would have the sweep revoke the grant it depends on.
export const CENTRAL_GATEKEEPER_RBAC_NAME = "central-gatekeeper";
export const CENTRAL_GATEKEEPER_SA_NAME = "gatekeeper";

export function buildCentralGatekeeperRole(namespace: string, prNumber: number): k8s.V1Role {
    return {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "Role",
        metadata: {
            name: CENTRAL_GATEKEEPER_RBAC_NAME,
            namespace,
            labels: { ...BASE_LABELS, "previewkit.dev/pr-number": String(prNumber) },
        },
        rules: [
            {
                // patch sets spec.replicas + the wake annotation to sleep/wake;
                // status (readyReplicas) is read to know when the namespace is up.
                apiGroups: ["apps"],
                resources: ["deployments", "statefulsets"],
                verbs: ["get", "list", "watch", "patch"],
            },
            {
                // pods: on wake, fail fast when a managed pod is wedged (bad
                // image, crash loop) instead of waiting out the wake timeout.
                apiGroups: [""],
                resources: ["pods"],
                verbs: ["list"],
            },
        ],
    };
}

export function buildCentralGatekeeperRoleBinding(
    namespace: string,
    gatekeeperNamespace: string,
    prNumber: number,
): k8s.V1RoleBinding {
    return {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: {
            name: CENTRAL_GATEKEEPER_RBAC_NAME,
            namespace,
            labels: { ...BASE_LABELS, "previewkit.dev/pr-number": String(prNumber) },
        },
        roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "Role",
            name: CENTRAL_GATEKEEPER_RBAC_NAME,
        },
        subjects: [{ kind: "ServiceAccount", name: CENTRAL_GATEKEEPER_SA_NAME, namespace: gatekeeperNamespace }],
    };
}

// Pod-template annotation carrying the ESO-managed K8s Secret's resourceVersion
// at deploy time, so a secret change produces a new pod template and rolls the
// pods (env vars from `envFrom` are only read at pod start).
export const SECRET_VERSION_ANNOTATION = "previewkit.dev/secret-version";

// Pod-template annotation carrying the commit SHA this deploy built from.
// `imageTag` is stable per (app, PR) - a new commit overwrites the same ECR
// tag - so without this the pod template would be byte-identical across
// commits and `kubectl apply` would never roll new pods onto the new image.
export const BUILD_SHA_ANNOTATION = "previewkit.dev/build-sha";

export function buildAppHostname(
    appName: string,
    prNumber: number,
    repoFullName: string,
    domain: string,
    secret: string,
): string {
    // HMAC-SHA256 keyed on secret: deterministic per (app, PR, repo) but
    // unguessable without the key.
    const hash = createHmac("sha256", secret)
        .update(`${appName}:${prNumber}:${repoFullName}`)
        .digest("hex")
        .slice(0, 12);
    return `${hash}.${domain}`;
}

export function buildAppDeployment(opts: AppResourceOptions): k8s.V1Deployment {
    const { app, namespace, imageTag, resolvedEnv, awsSecretName, secretVersion, headSha } = opts;
    const labels = {
        ...BASE_LABELS,
        app: app.name,
        "previewkit.dev/pr-number": String(opts.prNumber),
    };

    // Workloads this app must wait for at wake time. Gatekeeper reads this from the
    // Deployment annotation and scales dependencies up (and ready) before this app.
    const dependsOn = app.depends_on ?? [];

    // Drop any protected Previewkit keys a user may have set in config `env`
    // (built-ins AND the Autonoma-managed secrets): config `env` is not validated
    // against the protected set the way the secrets API is, and a plain `env`
    // entry would otherwise win over the `envFrom`-mounted managed secret (the
    // kubectl rule). Injecting the canonical built-ins below then always wins;
    // the managed secrets arrive via `envFrom` from the app's AWS SM bundle.
    const envVars = Object.entries(resolvedEnv)
        .filter(([name]) => !isProtectedPreviewkitEnvKey(name))
        .map(([name, value]) => ({ name, value }));
    if (!resolvedEnv.PORT) {
        envVars.push({ name: "PORT", value: String(app.port) });
    }
    envVars.push(
        { name: "AUTONOMA_PREVIEWKIT", value: "true" },
        { name: "AUTONOMA_PREVIEWKIT_PR", value: String(opts.prNumber) },
        { name: "AUTONOMA_PREVIEWKIT_URL", value: opts.publicUrl },
    );

    const envFrom: k8s.V1EnvFromSource[] = awsSecretName != null ? [{ secretRef: { name: awsSecretName } }] : [];

    return {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: {
            name: app.name,
            namespace,
            labels,
            ...(dependsOn.length > 0 && {
                annotations: { [GATEKEEPER_DEPENDS_ON_ANNOTATION]: dependsOn.join(",") },
            }),
        },
        spec: {
            // Preview apps always run a single replica
            replicas: 1,
            selector: { matchLabels: { app: app.name } },
            template: {
                metadata: {
                    labels: { ...labels, app: app.name },
                    annotations: {
                        // Roll the pods on every deploy: `imageTag` is stable per
                        // (app, PR), so without a per-commit annotation the pod
                        // template would be unchanged and `kubectl apply` would
                        // never re-pull the overwritten tag's new content.
                        [BUILD_SHA_ANNOTATION]: headSha,
                        // Roll the pods whenever the mounted secret changes: envFrom is
                        // captured at pod start, so a new secret version only reaches a
                        // running pod via a rollout (which a pod-template change forces).
                        ...(secretVersion != null && { [SECRET_VERSION_ANNOTATION]: secretVersion }),
                    },
                },
                spec: {
                    nodeSelector: { "kubernetes.io/arch": "amd64" },
                    containers: [
                        {
                            name: app.name,
                            image: imageTag,
                            imagePullPolicy: "Always",
                            ports: [{ containerPort: app.port }],
                            ...(envFrom.length > 0 && { envFrom }),
                            env: envVars,
                            ...(app.command && {
                                command: ["/bin/sh", "-c", app.command],
                            }),
                            resources: {
                                requests: {
                                    cpu: app.resources.cpu,
                                    memory: app.resources.memoryRequest,
                                },
                                limits: {
                                    memory: app.resources.memoryLimit,
                                },
                            },
                            ...(app.health_check && {
                                readinessProbe: {
                                    httpGet: {
                                        path: app.health_check,
                                        port: app.port,
                                    },
                                    initialDelaySeconds: 10,
                                    periodSeconds: 5,
                                },
                                livenessProbe: {
                                    httpGet: {
                                        path: app.health_check,
                                        port: app.port,
                                    },
                                    initialDelaySeconds: 15,
                                    periodSeconds: 10,
                                },
                            }),
                        },
                    ],
                },
            },
        },
    };
}

export function buildAppService(opts: AppResourceOptions): k8s.V1Service {
    const { app, namespace } = opts;
    const labels = {
        ...BASE_LABELS,
        app: app.name,
        "previewkit.dev/pr-number": String(opts.prNumber),
    };

    return {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: app.name, namespace, labels },
        spec: {
            // ClusterIP is fine: the ALB targets pod IPs directly via
            // TargetGroupConfiguration (targetType: ip), skipping the node hop.
            type: "ClusterIP",
            selector: { app: app.name },
            ports: [{ port: app.port, targetPort: app.port }],
        },
    };
}

// NOTE: preview routing is now owned by the CENTRAL Gatekeeper in `system`
// (deployment/previewkit/cluster/gatekeeper/): the deployer labels each preview
// Namespace gatekeeper.dev/managed=true and writes the host -> upstream table
// as the gatekeeper.dev/routes annotation (NamespaceManager
// ensureGatekeeperManagement). One wildcard Ingress in `system` carries every
// preview host, so no per-namespace proxy resources and no per-app Ingress are
// built here anymore. The legacy stamped resources on already-running previews
// are swept once by deployment/previewkit/cluster/gatekeeper/
// migrate-existing-previews.sh during rollout, not on the deploy path.
