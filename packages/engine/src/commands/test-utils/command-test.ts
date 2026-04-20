/**
 * Utility functions for testing commands.
 */

import { test } from "vitest";
import type { BaseCommandContext } from "../../platform";
import { FakeApplicationDriver } from "./fake-application.driver";
import { FakeScreenDriver } from "./fake-screen.driver";

export type CommandTestFunction<TContext extends BaseCommandContext, TArgs extends unknown[]> = ReturnType<
    typeof test.extend<"makeContext", (...parameters: TArgs) => TContext>
>;

/**
 * Create a custom test function that includes a fixture to build the context based on some parameters.
 *
 * @param contextFn - A function that builds the context for the command. The base context is provided by default, but can be overridden.
 * @returns The test function. Use it to create tests, the same way you would use vitest's `test` function.
 */
export function commandTestFunction<TContext extends BaseCommandContext, TArgs extends unknown[]>(
    contextFn: (...parameters: TArgs) => TContext,
): CommandTestFunction<TContext, TArgs> {
    return test.extend("makeContext", async () =>
        (...parameters: TArgs) =>
            contextFn(...parameters));
}

/**
 * Creates a base context with fake drivers.
 */
export function baseFakeContext() {
    return {
        screen: new FakeScreenDriver(),
        application: new FakeApplicationDriver(),
    };
}
