import type { LanguageModel } from "@autonoma/ai";
import { VisualConditionChecker } from "./visual-condition-checker";

export const ASSERT_SYSTEM_PROMPT =
    "You will receive an image of a website or mobile application and an user statement " +
    "about the image. \n\nYour task is to tell whether the user statement is true or false. This will be " +
    "used for asserting if stuff is correctly shown and present on the screen or not. Note that sometimes " +
    "the user might give negative statements like 'assert there's no download button' and if there's no " +
    "download button then it should be true. Some other times, the statements can be truthy like 'validate " +
    'that there\'s a title that says "Hello, Tom!"' +
    "' and that should be true as well.";

/**
 * The assert checker is used to check for user-generated assertions on a given screenshot.
 */
export class AssertChecker extends VisualConditionChecker {
    constructor(model: LanguageModel) {
        super({ model, systemPrompt: ASSERT_SYSTEM_PROMPT });
    }
}
