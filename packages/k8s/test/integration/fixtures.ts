import type { PreviewPowerState } from "../../src/preview-liveness/types";

// Tiny, always-Running container: no process of its own beyond pausing, so with
// no readiness probe its pod goes Ready immediately (-> healthy), and with a
// probe against a closed port it stays Running-but-not-Ready forever (-> waking).
const PAUSE_IMAGE = "registry.k8s.io/pause:3.9";
// Exits non-zero on every start, so the kubelet drives it into CrashLoopBackOff.
const CRASH_IMAGE = "busybox:1.36";
// Resolves to no registry, so the pod wedges in ImagePullBackOff.
const MISSING_IMAGE = "autonoma.invalid/does-not-exist:v0";

const MANAGED_LABEL = "previewkit.dev/managed-by: previewkit";

export interface ExpectedNamespace {
    namespace: string;
    /** undefined means the namespace must NOT appear in the fleet at all. */
    state?: PreviewPowerState;
    /** Fatal reasons that satisfy an `error` expectation (any one matches). */
    reasonOneOf?: string[];
}

export const NAMESPACES = [
    "preview-healthy",
    "preview-asleep",
    "preview-waking",
    "preview-imagepull",
    "preview-crashloop",
    "preview-mixed",
    "preview-unmanaged",
];

export const EXPECTATIONS: ExpectedNamespace[] = [
    { namespace: "preview-healthy", state: "healthy" },
    { namespace: "preview-asleep", state: "asleep" },
    { namespace: "preview-waking", state: "waking" },
    { namespace: "preview-imagepull", state: "error", reasonOneOf: ["ImagePullBackOff", "ErrImagePull"] },
    { namespace: "preview-crashloop", state: "error", reasonOneOf: ["CrashLoopBackOff"] },
    { namespace: "preview-mixed", state: "error", reasonOneOf: ["ImagePullBackOff", "ErrImagePull"] },
    { namespace: "preview-unmanaged", state: undefined },
];

export function namespacesManifest(): string {
    return NAMESPACES.map((name) => `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${name}`).join("\n---\n");
}

export function workloadsManifest(): string {
    return [
        // Healthy: a Deployment and a StatefulSet, both Ready -> namespace healthy
        // (also exercises the StatefulSet path and multi-workload rollup).
        deployment({ namespace: "preview-healthy", name: "web", image: PAUSE_IMAGE }),
        statefulSet({ namespace: "preview-healthy", name: "db", image: PAUSE_IMAGE }),

        // Asleep: Gatekeeper's fingerprint - replicas 0 + the wake-replicas annotation.
        deployment({
            namespace: "preview-asleep",
            name: "web",
            image: PAUSE_IMAGE,
            replicas: 0,
            annotations: { "gatekeeper.dev/wake-replicas": "1" },
        }),

        // Waking: Running but never Ready (readiness probe hits a closed port).
        deployment({
            namespace: "preview-waking",
            name: "web",
            image: PAUSE_IMAGE,
            readinessProbeClosedPort: true,
        }),

        // Error via image pull failure.
        deployment({ namespace: "preview-imagepull", name: "web", image: MISSING_IMAGE }),

        // Error via crashloop.
        deployment({
            namespace: "preview-crashloop",
            name: "web",
            image: CRASH_IMAGE,
            command: ["sh", "-c", "exit 1"],
        }),

        // Mixed: one healthy + one broken -> rollup must be error.
        deployment({ namespace: "preview-mixed", name: "web", image: PAUSE_IMAGE }),
        deployment({ namespace: "preview-mixed", name: "broken", image: MISSING_IMAGE }),

        // Control: no managed label, so the label-filtered LIST must skip it.
        deployment({ namespace: "preview-unmanaged", name: "web", image: PAUSE_IMAGE, managed: false }),
    ].join("\n---\n");
}

interface DeploymentOpts {
    namespace: string;
    name: string;
    image: string;
    replicas?: number;
    command?: string[];
    readinessProbeClosedPort?: boolean;
    annotations?: Record<string, string>;
    managed?: boolean;
}

function deployment(opts: DeploymentOpts): string {
    const managed = opts.managed ?? true;
    return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${opts.name}
  namespace: ${opts.namespace}
  labels:
${indent(labelLines(opts.name, managed), 4)}
${annotationBlock(opts.annotations, 2)}spec:
  replicas: ${opts.replicas ?? 1}
  selector:
    matchLabels:
      app: ${opts.name}
  template:
    metadata:
      labels:
${indent(labelLines(opts.name, managed), 8)}
    spec:
${indent(containerBlock(opts.name, opts.image, opts.command, opts.readinessProbeClosedPort), 6)}`;
}

function statefulSet(opts: { namespace: string; name: string; image: string }): string {
    return `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: ${opts.name}
  namespace: ${opts.namespace}
  labels:
${indent(labelLines(opts.name, true), 4)}
spec:
  serviceName: ${opts.name}
  replicas: 1
  selector:
    matchLabels:
      app: ${opts.name}
  template:
    metadata:
      labels:
${indent(labelLines(opts.name, true), 8)}
    spec:
${indent(containerBlock(opts.name, opts.image), 6)}`;
}

function labelLines(name: string, managed: boolean): string {
    const lines = [`app: ${name}`];
    if (managed) lines.unshift(MANAGED_LABEL);
    return lines.join("\n");
}

function annotationBlock(annotations: Record<string, string> | undefined, indentSpaces: number): string {
    if (annotations == null) return "";
    const pad = " ".repeat(indentSpaces);
    const entries = Object.entries(annotations)
        .map(([key, value]) => `${pad}  ${key}: "${value}"`)
        .join("\n");
    return `${pad}annotations:\n${entries}\n`;
}

function containerBlock(name: string, image: string, command?: string[], readinessProbeClosedPort?: boolean): string {
    // Lines are written relative to the block's own column 0; the caller indents
    // the whole block under template.spec. `command`/`readinessProbe` sit at 4
    // spaces, siblings of `image` under the `- name:` list item.
    const probe = readinessProbeClosedPort
        ? `    readinessProbe:
      tcpSocket:
        port: 9
      periodSeconds: 2
      failureThreshold: 1`
        : undefined;
    const cmd = command != null ? `    command: [${command.map((c) => JSON.stringify(c)).join(", ")}]` : undefined;
    return ["containers:", `  - name: ${name}`, `    image: ${image}`, cmd, probe]
        .filter((line) => line != null)
        .join("\n");
}

function indent(block: string, spaces: number): string {
    const pad = " ".repeat(spaces);
    return block
        .split("\n")
        .map((line) => (line.length > 0 ? pad + line : line))
        .join("\n");
}
