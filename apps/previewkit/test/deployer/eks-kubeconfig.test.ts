import { describe, expect, it, vi } from "vitest";
import { EksKubeconfigLoader } from "../../src/deployer/eks-kubeconfig";

const STATIC_CLUSTER = {
    endpoint: "https://preview.example.test",
    caData: "dGVzdC1jYQ==",
};

describe("EksKubeconfigLoader", () => {
    it("reuses a young token for ordinary loads", async () => {
        let now = 0;
        const tokenFactory = vi.fn().mockResolvedValueOnce("token-1");
        const loader = new EksKubeconfigLoader("preview", "us-east-1", STATIC_CLUSTER, {
            now: () => now,
            tokenFactory,
        });

        const first = await loader.load();
        now = 45_000;
        const second = await loader.load();

        expect(second).toBe(first);
        expect(second.getCurrentUser()?.token).toBe("token-1");
        expect(tokenFactory).toHaveBeenCalledTimes(1);
    });

    it("forces a new token before the cached token expires", async () => {
        let now = 0;
        const tokenFactory = vi.fn().mockResolvedValueOnce("token-1").mockResolvedValueOnce("token-2");
        const loader = new EksKubeconfigLoader("preview", "us-east-1", STATIC_CLUSTER, {
            now: () => now,
            tokenFactory,
        });

        const kubeconfig = await loader.load();
        now = 30_000;
        const refreshed = await loader.refresh();

        expect(refreshed).toBe(kubeconfig);
        expect(refreshed.getCurrentUser()?.token).toBe("token-2");
        expect(tokenFactory).toHaveBeenCalledTimes(2);
    });
});
