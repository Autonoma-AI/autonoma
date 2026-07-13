import { z } from "zod";

export const RedeployPreviewkitAppInputSchema = z.object({
    applicationId: z.string().min(1),
    environmentId: z.string().min(1),
    app: z.string().min(1),
    mode: z.enum(["rebuild", "restart"]),
});
