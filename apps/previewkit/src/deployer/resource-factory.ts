import { createHmac } from "node:crypto";
import { isReservedPreviewkitEnvKey } from "@autonoma/types";
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
}

interface AppRouteOptions {
    app: AppConfig;
    namespace: string;
    prNumber: number;
    repoFullName: string;
    domain: string;
    secret: string;
    ingressClassName: string;
}

const BASE_LABELS = {
    "previewkit.dev/managed-by": "previewkit",
};

// Label selector matching every previewkit-managed workload (exactly what BASE_LABELS
// stamps on apps + service recipes). Passed to Gatekeeper as TARGET_SELECTOR so it scales
// precisely those workloads - the published image's default selector
// (gatekeeper.dev/scale-to-zero=true) matches nothing in a preview namespace.
const MANAGED_SELECTOR = Object.entries(BASE_LABELS)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

// Gatekeeper is the per-namespace auth + scale-to-zero proxy (replaces the old
// stock-nginx proxy). One Deployment/Service/ServiceAccount/Role/RoleBinding per
// namespace, all sharing this name. It listens on 8080 (nonroot cannot bind <1024)
// behind a Service exposed on port 80, which the per-app Ingress targets.
export const GATEKEEPER_NAME = "gatekeeper";
export const GATEKEEPER_APP_LABEL = "gatekeeper";
export const GATEKEEPER_SERVICE_NAME = "gatekeeper";
export const GATEKEEPER_SERVICE_PORT = 80;
export const GATEKEEPER_CONTAINER_PORT = 8080;
export const GATEKEEPER_CONFIGMAP_NAME = "gatekeeper-routes";
export const GATEKEEPER_HEALTH_PATH = "/gatekeeper-health";
// Annotation Gatekeeper reads to wake workloads in dependency order (matches the
// image's default DEPENDS_ON_ANNOTATION). Value is a comma-separated list of the
// workload names this one depends on, so e.g. a web app's database is scaled up
// and ready before the app itself is woken.
export const GATEKEEPER_DEPENDS_ON_ANNOTATION = "gatekeeper.dev/depends-on";

// Pod-template annotation carrying the ESO-managed K8s Secret's resourceVersion
// at deploy time, so a secret change produces a new pod template and rolls the
// pods (env vars from `envFrom` are only read at pod start).
export const SECRET_VERSION_ANNOTATION = "previewkit.dev/secret-version";

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
    const { app, namespace, imageTag, resolvedEnv, awsSecretName, secretVersion } = opts;
    const labels = {
        ...BASE_LABELS,
        app: app.name,
        "previewkit.dev/pr-number": String(opts.prNumber),
    };

    // Workloads this app must wait for at wake time. Gatekeeper reads this from the
    // Deployment annotation and scales dependencies up (and ready) before this app.
    const dependsOn = app.depends_on ?? [];

    // Drop any reserved Previewkit built-in keys a user may have set (config
    // `env` is not validated against the reserved set the way the secrets API
    // is), then inject the canonical built-ins below so they always win.
    const envVars = Object.entries(resolvedEnv)
        .filter(([name]) => !isReservedPreviewkitEnvKey(name))
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
            replicas: app.replicas,
            selector: { matchLabels: { app: app.name } },
            template: {
                metadata: {
                    labels: { ...labels, app: app.name },
                    // Roll the pods whenever the mounted secret changes: envFrom is
                    // captured at pod start, so a new secret version only reaches a
                    // running pod via a rollout (which a pod-template change forces).
                    ...(secretVersion != null && {
                        annotations: { [SECRET_VERSION_ANNOTATION]: secretVersion },
                    }),
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

/**
 * Per-preview routing is a plain Ingress consumed by the shared in-cluster
 * ingress-nginx — NOT a Gateway HTTPRoute. The ALB Gateway forwards all of
 * `*.preview.autonoma.app` to ingress-nginx through one static HTTPRoute, and
 * ingress-nginx fans out by Host header. This keeps the ALB at a fixed 1 rule +
 * 1 target group no matter how many previews exist, sidestepping the per-ALB
 * 100-rule / 100-target-group quotas that one-route-per-preview would hit.
 *
 * The Ingress targets this namespace's `gatekeeper` Service, which authenticates
 * every request and scales the namespace to zero when idle; TLS terminates
 * upstream at the ALB, so the Ingress declares no `tls` block.
 */
export function buildAppIngress(opts: AppRouteOptions): k8s.V1Ingress {
    const { app, namespace, prNumber, repoFullName, domain, secret, ingressClassName } = opts;
    const host = buildAppHostname(app.name, prNumber, repoFullName, domain, secret);

    return {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: {
            name: app.name,
            namespace,
            labels: routeLabels(app.name, prNumber),
        },
        spec: {
            ingressClassName,
            rules: [
                {
                    host,
                    http: {
                        paths: [
                            {
                                path: "/",
                                pathType: "Prefix",
                                backend: {
                                    service: {
                                        name: GATEKEEPER_SERVICE_NAME,
                                        port: { number: GATEKEEPER_SERVICE_PORT },
                                    },
                                },
                            },
                        ],
                    },
                },
            ],
        },
    };
}

interface GatekeeperOptions {
    apps: Array<{ name: string; port: number; hostname: string }>;
    namespace: string;
    prNumber: number;
    bypassToken: string;
    cookieDomain: string;
    appUrl: string;
    image: string;
    idleTimeout: string;
}

function gatekeeperLabels(prNumber: number): Record<string, string> {
    return {
        ...BASE_LABELS,
        app: GATEKEEPER_APP_LABEL,
        "previewkit.dev/pr-number": String(prNumber),
    };
}

/**
 * ConfigMap holding the host -> upstream routing table Gatekeeper reads via the
 * ROUTES_JSON env var. Keys are the per-app HMAC preview hostnames.
 */
export function buildGatekeeperConfigMap(opts: {
    apps: Array<{ name: string; port: number; hostname: string }>;
    namespace: string;
    prNumber: number;
}): k8s.V1ConfigMap {
    const routes: Record<string, { service: string; port: number }> = {};
    for (const app of opts.apps) {
        routes[app.hostname] = { service: app.name, port: app.port };
    }
    return {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
            name: GATEKEEPER_CONFIGMAP_NAME,
            namespace: opts.namespace,
            labels: gatekeeperLabels(opts.prNumber),
        },
        data: { "routes.json": JSON.stringify(routes) },
    };
}

export function buildGatekeeperDeployment(opts: GatekeeperOptions): k8s.V1Deployment {
    // These env vars must match the published image's contract
    // (github.com/autonoma-ai/gatekeeper). Previews are public, so AUTH_TOKEN is
    // intentionally unset - Gatekeeper runs as a pure scale-to-zero proxy.
    //   - HEALTH_PATH: serve health where the readiness probe checks. Without it the
    //     image defaults to /healthz, the probe 404s, and the pod never goes Ready.
    //   - TARGET_SELECTOR + SELF_NAME: scale the previewkit-managed workloads, never itself.
    const env: k8s.V1EnvVar[] = [
        { name: "NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
        { name: "IDLE_TIMEOUT", value: "0" },
        { name: "HEALTH_PATH", value: GATEKEEPER_HEALTH_PATH },
        { name: "TARGET_SELECTOR", value: MANAGED_SELECTOR },
        { name: "SELF_NAME", value: GATEKEEPER_NAME },
        {
            name: "ROUTES_JSON",
            valueFrom: { configMapKeyRef: { name: GATEKEEPER_CONFIGMAP_NAME, key: "routes.json" } },
        },
    ];

    return {
        apiVersion: "apps/v1",
        kind: "Deployment",
        metadata: { name: GATEKEEPER_NAME, namespace: opts.namespace, labels: gatekeeperLabels(opts.prNumber) },
        spec: {
            replicas: 1,
            selector: { matchLabels: { app: GATEKEEPER_APP_LABEL } },
            template: {
                metadata: { labels: gatekeeperLabels(opts.prNumber) },
                spec: {
                    serviceAccountName: GATEKEEPER_NAME,
                    nodeSelector: { "kubernetes.io/arch": "amd64" },
                    containers: [
                        {
                            name: GATEKEEPER_NAME,
                            image: opts.image,
                            imagePullPolicy: "Always",
                            ports: [{ containerPort: GATEKEEPER_CONTAINER_PORT }],
                            env,
                            resources: {
                                requests: { cpu: "256m", memory: "128Mi" },
                                limits: { memory: "256Mi" },
                            },
                            readinessProbe: {
                                httpGet: { path: GATEKEEPER_HEALTH_PATH, port: GATEKEEPER_CONTAINER_PORT },
                                initialDelaySeconds: 2,
                                periodSeconds: 5,
                            },
                        },
                    ],
                },
            },
        },
    };
}

export function buildGatekeeperService(namespace: string, prNumber: number): k8s.V1Service {
    return {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: GATEKEEPER_SERVICE_NAME, namespace, labels: gatekeeperLabels(prNumber) },
        spec: {
            type: "ClusterIP",
            selector: { app: GATEKEEPER_APP_LABEL },
            ports: [{ port: GATEKEEPER_SERVICE_PORT, targetPort: GATEKEEPER_CONTAINER_PORT }],
        },
    };
}

export function buildGatekeeperServiceAccount(namespace: string, prNumber: number): k8s.V1ServiceAccount {
    return {
        apiVersion: "v1",
        kind: "ServiceAccount",
        metadata: { name: GATEKEEPER_NAME, namespace, labels: gatekeeperLabels(prNumber) },
    };
}

/**
 * Least-privilege namespaced Role: Gatekeeper patches replicas + the wake
 * annotation on managed Deployments/StatefulSets, reads their status to know when
 * the namespace is ready, and lists pods to fail a wake fast when one is wedged.
 * It runs as its own in-cluster ServiceAccount (not previewkit's cross-cluster creds).
 */
export function buildGatekeeperRole(namespace: string, prNumber: number): k8s.V1Role {
    return {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "Role",
        metadata: { name: GATEKEEPER_NAME, namespace, labels: gatekeeperLabels(prNumber) },
        rules: [
            {
                // Gatekeeper polls workload status (readyReplicas) to know when the
                // whole namespace is awake before proxying, and patches spec.replicas
                // to sleep/wake.
                apiGroups: ["apps"],
                resources: ["deployments", "statefulsets"],
                verbs: ["get", "list", "watch", "patch"],
            },
            {
                // pods: on wake, fail fast when a managed pod is wedged (bad image,
                // crash loop) instead of waiting out the wake timeout.
                apiGroups: [""],
                resources: ["pods"],
                verbs: ["list"],
            },
        ],
    };
}

export function buildGatekeeperRoleBinding(namespace: string, prNumber: number): k8s.V1RoleBinding {
    return {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "RoleBinding",
        metadata: { name: GATEKEEPER_NAME, namespace, labels: gatekeeperLabels(prNumber) },
        roleRef: {
            apiGroup: "rbac.authorization.k8s.io",
            kind: "Role",
            name: GATEKEEPER_NAME,
        },
        subjects: [{ kind: "ServiceAccount", name: GATEKEEPER_NAME, namespace }],
    };
}

function routeLabels(appName: string, prNumber: number): Record<string, string> {
    return {
        ...BASE_LABELS,
        app: appName,
        "previewkit.dev/pr-number": String(prNumber),
    };
}
