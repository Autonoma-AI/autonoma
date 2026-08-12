import { logger as rootLogger } from "@autonoma/logger";
import type { StorageProvider } from "@autonoma/storage";
import { describe, expect, it } from "vitest";
import type { FrozenAppLogWindow } from "../evals/classifier/classifier-input";
import { FrozenAppLogArtifactError, FrozenAppLogArtifactStore } from "../evals/classifier/frozen-app-log-artifact";

const logger = rootLogger.child({ name: "frozen-app-log-artifact.test" });
const CLASSIFICATION_ID = "cmsqf9dyy000c0nymzl1cq85y";
const WINDOW: FrozenAppLogWindow = {
    namespace: "preview-acme-storefront-pr-1234",
    lines: [{ timestampNs: "1770000060000000000", line: "ERROR checkout failed: ECONNREFUSED" }],
    windowTruncated: false,
};

class MemoryStorage implements StorageProvider {
    private readonly objects = new Map<string, Buffer>();

    public async upload(key: string, data: Buffer): Promise<string> {
        this.objects.set(key, data);
        return `s3://autonoma-dev/${key}`;
    }

    public async uploadStream(): Promise<string> {
        throw new Error("Not implemented");
    }

    public async download(key: string): Promise<Buffer> {
        const data = this.objects.get(key.replace("s3://autonoma-dev/", ""));
        if (data == null) throw new Error(`Object not found: ${key}`);
        return data;
    }

    public async delete(): Promise<void> {
        throw new Error("Not implemented");
    }

    public async getSignedUrl(): Promise<string> {
        throw new Error("Not implemented");
    }

    public overwrite(key: string, data: Buffer): void {
        this.objects.set(key, data);
    }
}

describe("FrozenAppLogArtifactStore", () => {
    it("stores raw lines privately and commits only an integrity-checked reference", async () => {
        const storage = new MemoryStorage();
        const artifacts = new FrozenAppLogArtifactStore(storage, logger);

        const artifact = await artifacts.write(CLASSIFICATION_ID, WINDOW);
        const restored = await artifacts.read(artifact);

        expect(artifact.key).toMatch(
            new RegExp(`^s3://autonoma-dev/classifier-app-logs/${CLASSIFICATION_ID}-[a-f0-9]{64}\\.json$`),
        );
        expect(artifact.namespace).toBe(WINDOW.namespace);
        expect(artifact.lineCount).toBe(1);
        expect(artifact.windowTruncated).toBe(false);
        expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(artifact)).not.toContain(WINDOW.lines[0]?.line ?? "");
        expect(restored).toEqual(WINDOW);
    });

    it("refuses an artifact whose bytes no longer match its committed checksum", async () => {
        const storage = new MemoryStorage();
        const artifacts = new FrozenAppLogArtifactStore(storage, logger);
        const artifact = await artifacts.write(CLASSIFICATION_ID, WINDOW);

        storage.overwrite(artifact.key.replace("s3://autonoma-dev/", ""), Buffer.from("{}", "utf-8"));

        await expect(artifacts.read(artifact)).rejects.toBeInstanceOf(FrozenAppLogArtifactError);
    });

    it("refuses an artifact whose contents disagree with its committed metadata", async () => {
        const storage = new MemoryStorage();
        const artifacts = new FrozenAppLogArtifactStore(storage, logger);
        const artifact = await artifacts.write(CLASSIFICATION_ID, WINDOW);
        const incorrectMetadata = { ...artifact, lineCount: 0 };

        await expect(artifacts.read(incorrectMetadata)).rejects.toBeInstanceOf(FrozenAppLogArtifactError);
    });
});
