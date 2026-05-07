import z from "zod";

export interface NavigateCommandSpec {
    interaction: "navigate";
    params: { url: string };
    output: { outcome: string; url: string };
}

export const navigateParamsSchema = z.object({
    url: z.string().describe("The URL to navigate to. Can be a full URL, a URL without protocol, or a relative path."),
}) satisfies z.ZodType<NavigateCommandSpec["params"]>;
