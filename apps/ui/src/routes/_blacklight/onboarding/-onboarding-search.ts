import { z } from "zod";

export const onboardingSearchSchema = z.object({ appId: z.string() });
