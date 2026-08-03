import type { z } from "zod";

/**
 * A model-filled field that must be emitted but may have nothing behind it: nullable on the wire, `undefined` to us.
 *
 * OpenAI's strict structured-output mode requires every property to appear in `required`, so `.optional()` does not
 * make a field omittable. Null is the only way the model can decline, so a declinable field's `.describe()` must
 * say "pass null", never "omit".
 */
export function declinable<T extends z.ZodType>(schema: T) {
    return schema.nullable().transform((value) => value ?? undefined);
}
