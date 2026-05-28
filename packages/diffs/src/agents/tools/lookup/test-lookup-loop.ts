import type { AgentLoop } from "@autonoma/ai";
import type { ExistingTestInfo } from "../../../diffs-agent";
import type { FlowIndex } from "../../../flow-index";

/**
 * Loop that knows about the existing test suite: the flow tree and the tests under each flow.
 * Consumed by `list_flows`, `list_tests`, `read_tests`.
 */
export interface TestLookupLoop extends AgentLoop {
    readonly flowIndex: FlowIndex;
    readonly existingTests: ExistingTestInfo[];
}
