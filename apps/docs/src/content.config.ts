import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

export const collections = {
    docs: defineCollection({
        loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/docs" }),
        schema: z.object({
            title: z.string(),
            description: z.string().optional(),
        }),
    }),
};
