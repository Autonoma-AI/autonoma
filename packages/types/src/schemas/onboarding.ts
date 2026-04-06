import { z } from "zod";

export const AgentLogEntrySchema = z.object({
    id: z.string(),
    message: z.string(),
    timestamp: z.string(),
});
export type AgentLogEntry = z.infer<typeof AgentLogEntrySchema>;
