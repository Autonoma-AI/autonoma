import type { ResultCollector } from "../src/tools/finish-tool";

export function createEmptyCollector(): ResultCollector {
    return {
        affectedTests: [],
        testCandidates: [],
    };
}
