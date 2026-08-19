import { z } from "zod";

/**
 * An ordered list of edits to an Application's preview config, applied in one
 * transaction.
 *
 * The list exists for one thing a document cannot say: **rename**. A document
 * shows only the after-state, so an app that arrives under a new name is
 * indistinguishable from a new app, and the server has no choice but to delete the
 * old row - taking its secrets and its build history with it, since both cascade
 * from it. `renameApp` names the row, so the id survives and so does everything
 * hanging off it.
 *
 * `replaceConfig` keeps the whole-document write, because most edits genuinely are
 * "here is the topology I want" and an agent composing one is far more reliable
 * than an agent composing a correct edit list. Ordering is what makes the two work
 * together: renames run first, so the document that follows matches the app by its
 * new name and updates the row in place instead of replacing it.
 */
export const previewkitOperationSchema = z.discriminatedUnion("op", [
    z.object({
        op: z.literal("renameApp"),
        /** The app ROW, not its current name - that is the point of this operation. */
        appId: z.string().min(1),
        name: z.string().min(1),
    }),
    z.object({
        op: z.literal("replaceConfig"),
        /**
         * A whole config document. Parsed against the authoring contract by the
         * applier rather than here, so this schema stays free of the config's own
         * shape and one parse failure reports against one contract.
         */
        document: z.unknown(),
    }),
    z.object({
        op: z.literal("setSecret"),
        /** The app's name as the document leaves it - resolved after the renames. */
        app: z.string().min(1),
        key: z.string().min(1),
        value: z.string(),
    }),
    z.object({
        op: z.literal("deleteSecret"),
        app: z.string().min(1),
        key: z.string().min(1),
    }),
]);

export type PreviewkitOperation = z.infer<typeof previewkitOperationSchema>;

export const previewkitOperationsSchema = z.array(previewkitOperationSchema).min(1);

export type PreviewkitOperations = z.infer<typeof previewkitOperationsSchema>;
