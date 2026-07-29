import { z } from "zod";

// Vercel Partner API installation status vocabulary - see
// https://vercel.com/docs/integrations/partner-api#get-installation
export const VercelInstallationWireStatusSchema = z.enum([
    "ready",
    "pending",
    "onboarding",
    "suspended",
    "resumed",
    "uninstalled",
    "error",
]);
export type VercelInstallationWireStatus = z.infer<typeof VercelInstallationWireStatusSchema>;
