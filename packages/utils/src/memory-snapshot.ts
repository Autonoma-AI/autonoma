import { readFileSync } from "node:fs";

const BYTES_PER_MIB = 1024 * 1024;

// Tried in order: cgroup v2's unified hierarchy, then v1's memory controller.
const CGROUP_MEMORY_PATHS = ["/sys/fs/cgroup/memory.current", "/sys/fs/cgroup/memory/memory.usage_in_bytes"];

export interface MemorySnapshot {
    /** Resident set size of this Node process alone. */
    rssMb: number;
    heapUsedMb: number;
    /** Non-heap V8-managed memory (Buffers, typed arrays, etc.), not included in `heapUsedMb`. */
    externalMb: number;
    arrayBuffersMb: number;
    /**
     * Whole-container cgroup memory - this process plus any children (e.g. a
     * spawned CLI). `undefined` where no cgroup memory file is readable
     * (non-Linux, local dev, tests). A gap between this and `rssMb` points at
     * a child process rather than the Node heap.
     */
    cgroupMb?: number;
}

/** Snapshot of this process's own memory plus, where available, the whole container's cgroup memory. */
export function takeMemorySnapshot(): MemorySnapshot {
    const usage = process.memoryUsage();
    const cgroupBytes = readCgroupMemoryBytes();
    return {
        rssMb: toMib(usage.rss),
        heapUsedMb: toMib(usage.heapUsed),
        externalMb: toMib(usage.external),
        arrayBuffersMb: toMib(usage.arrayBuffers),
        cgroupMb: cgroupBytes != null ? toMib(cgroupBytes) : undefined,
    };
}

function readCgroupMemoryBytes(): number | undefined {
    for (const path of CGROUP_MEMORY_PATHS) {
        try {
            return Number.parseInt(readFileSync(path, "utf8").trim(), 10);
        } catch (err) {
            console.debug(`[takeMemorySnapshot] cgroup memory file unavailable, trying next: ${path}`, err);
        }
    }
    return undefined;
}

function toMib(bytes: number): number {
    return Math.round((bytes / BYTES_PER_MIB) * 10) / 10;
}
