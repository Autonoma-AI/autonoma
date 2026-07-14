/**
 * Screenshot-driven AI primitives: visual checkers (condition/assert/text/choice) and
 * point/object detection. These operate on {@link Screenshot} images and therefore depend on
 * `@autonoma/image` -> `sharp`. Sharp-free callers use `@autonoma/ai` directly.
 */

export { VisualConditionChecker, type VisualConditionCheckerConfig } from "./visual/visual-condition-checker";
export { AssertChecker } from "./visual/assert-checker";
export { TextExtractor } from "./visual/text-extractor";
export {
    VisualChooser,
    type VisualChooserConfig,
    DEFAULT_VISUAL_CHOOSING_SYSTEM_PROMPT,
} from "./visual/visual-chooser";

export * from "./freestyle/object";
export * from "./freestyle/point";
