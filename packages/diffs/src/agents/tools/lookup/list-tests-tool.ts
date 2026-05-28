import { AgentTool, FixableToolError } from "@autonoma/ai";
import { z } from "zod";
import type { QuarantineInfo } from "../../../diffs-agent";
import type { TestLookupLoop } from "./test-lookup-loop";

const listTestsInputSchema = z.object({
    flowName: z.string().describe("The name of the flow (folder) to list tests for."),
});

type ListTestsInput = z.infer<typeof listTestsInputSchema>;

interface ListTestsEntry {
    slug: string;
    name: string;
    quarantine?: QuarantineInfo;
}

interface ListTestsOutput {
    flowName: string;
    tests: ListTestsEntry[];
    count: number;
}

class UnknownFlowError extends FixableToolError {
    constructor(public readonly flowName: string) {
        super(`Flow "${flowName}" not found. Use the flows listed in the system prompt.`);
    }

    override suggestFix(): string {
        return "Call `list_flows` to see the available flow names, then try again with one of those.";
    }
}

/** List tests in a specific flow (folder). */
export class ListTestsTool extends AgentTool<ListTestsInput, ListTestsOutput, TestLookupLoop> {
    constructor() {
        super({
            name: "list_tests",
            description:
                "List all tests in a specific flow (folder). Returns the slug and name of each test. " +
                "Use read_tests (which accepts an array of slugs) to read the full instructions of one or more tests in a single call.",
            inputSchema: listTestsInputSchema,
        });
    }

    protected async execute({ flowName }: ListTestsInput, loop: TestLookupLoop): Promise<ListTestsOutput> {
        const slugs = loop.flowIndex.getTestSlugs(flowName);
        if (slugs == null) throw new UnknownFlowError(flowName);

        const testsBySlug = new Map(loop.existingTests.map((t) => [t.slug, t]));
        const tests: ListTestsEntry[] = slugs.map((slug) => {
            const test = testsBySlug.get(slug);
            return { slug, name: test?.name ?? slug, quarantine: test?.quarantine };
        });

        return { flowName, tests, count: tests.length };
    }
}
