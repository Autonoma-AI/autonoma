import { TestCaseFrontmatterSchema } from "@autonoma/types";
import yaml from "js-yaml";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParsedTestMarkdown {
    description: string;
    plan: string;
}

/**
 * Splits an uploaded E2E test file into its validated frontmatter `description`
 * and plan body, mirroring server-side artifact ingestion. Throws when the file
 * lacks frontmatter or a conformant description.
 */
export function parseTestMarkdown(content: string): ParsedTestMarkdown {
    const match = FRONTMATTER_PATTERN.exec(content);
    if (match == null) {
        throw new Error("File must start with YAML frontmatter containing a description.");
    }

    const frontmatter = TestCaseFrontmatterSchema.parse(yaml.load(match[1] ?? ""));
    return { description: frontmatter.description, plan: (match[2] ?? "").trim() };
}
