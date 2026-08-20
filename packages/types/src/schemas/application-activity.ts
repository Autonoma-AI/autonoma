import { z } from "zod";

/** Every field is monotonic, false to true and never back, which is what makes a long staleTime safe here. */
export const ApplicationActivitySchema = z.object({
    /**
     * A pull request has existed on this application, open or since closed. Nothing else in the API answers
     * this: `branches.list` is filtered by state and paginated, so an empty first page of "open" proves only
     * that none is open right now.
     */
    hasEverOpenedPullRequest: z.boolean(),
    /**
     * An analysis run has happened. The SAME definition as `suiteHealth.hasEverRun` - both read `firstRunAt`,
     * which excludes MANUAL snapshots so a suite edit at setup is not counted as a run.
     */
    hasEverRun: z.boolean(),
    firstRunAt: z.date().optional(),
    /** When Autonoma was first allowed to act on the repository. Only meaningful while `hasEverRun` is false. */
    liveSince: z.date().optional(),
    previewMode: z.enum(["previewkit", "existing_deploys"]).optional(),
});

export type ApplicationActivity = z.infer<typeof ApplicationActivitySchema>;
