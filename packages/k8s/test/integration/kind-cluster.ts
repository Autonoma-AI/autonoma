import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KubeConfig } from "@kubernetes/client-node";

// Real kind cluster lifecycle for the integration suite. Everything here shells
// out to `kind`/`kubectl` on purpose: the point of these tests is to run the
// shipped read path against a genuine Kubernetes API server, not a mock.

export interface KindCluster {
    name: string;
    kubeconfigPath: string;
    kubeConfig: KubeConfig;
}

/** Whether kind, kubectl, and a reachable Docker daemon are all present. */
export function kindAvailable(): boolean {
    return which("kind") && which("kubectl") && dockerReachable();
}

export function createKindCluster(name: string): KindCluster {
    const dir = mkdtempSync(join(tmpdir(), "kind-liveness-"));
    const kubeconfigPath = join(dir, "kubeconfig");

    // --wait blocks until the control plane is Ready, so the first API call in a
    // test does not race cluster startup.
    execFileSync("kind", ["create", "cluster", "--name", name, "--kubeconfig", kubeconfigPath, "--wait", "90s"], {
        stdio: "inherit",
    });

    const kubeConfig = new KubeConfig();
    kubeConfig.loadFromFile(kubeconfigPath);
    return { name, kubeconfigPath, kubeConfig };
}

export function deleteKindCluster(cluster: KindCluster): void {
    spawnSync("kind", ["delete", "cluster", "--name", cluster.name], { stdio: "inherit" });
    rmSync(cluster.kubeconfigPath, { force: true });
}

/** Applies a YAML document to the cluster via `kubectl apply -f -`. */
export function applyManifests(cluster: KindCluster, yaml: string): void {
    const result = spawnSync("kubectl", ["--kubeconfig", cluster.kubeconfigPath, "apply", "-f", "-"], {
        input: yaml,
        encoding: "utf8",
    });
    if (result.status !== 0) {
        throw new Error(`kubectl apply failed (${result.status}): ${result.stderr}\n${result.stdout}`);
    }
}

function which(binary: string): boolean {
    return spawnSync("which", [binary]).status === 0;
}

function dockerReachable(): boolean {
    return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}
