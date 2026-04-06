import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Logger, logger } from "@autonoma/logger";
import type { ExistingSkillInfo, ExistingTestInfo } from "./diffs-agent";

interface CreateTestDirectoryParams {
    workingDirectory: string;
    tests: ExistingTestInfo[];
    skills: ExistingSkillInfo[];
}

interface WriteTestParams {
    slug: string;
    name: string;
    prompt: string;
}

interface WriteSkillParams {
    slug: string;
    name: string;
    description: string;
    content: string;
}

export class TestDirectory {
    private readonly logger: Logger;

    private constructor(private readonly workingDirectory: string) {
        this.logger = logger.child({ name: this.constructor.name, workingDirectory });
    }

    get testsDir(): string {
        return join(this.workingDirectory, "autonoma", "qa-tests");
    }

    get skillsDir(): string {
        return join(this.workingDirectory, "autonoma", "skills");
    }

    static async load(workingDirectory: string): Promise<TestDirectory> {
        return new TestDirectory(workingDirectory);
    }

    static async create({ workingDirectory, tests, skills }: CreateTestDirectoryParams): Promise<TestDirectory> {
        const dir = new TestDirectory(workingDirectory);
        dir.logger.info("Creating test directory", { tests: tests.length, skills: skills.length });

        await Promise.all([mkdir(dir.testsDir, { recursive: true }), mkdir(dir.skillsDir, { recursive: true })]);

        await Promise.all([
            ...tests.map((test) => dir.writeTest(test)),
            ...skills.map((skill) => dir.writeSkill(skill)),
        ]);

        dir.logger.info("Test directory created", { tests: tests.length, skills: skills.length });
        return dir;
    }

    async writeTest({ slug, name, prompt }: WriteTestParams): Promise<void> {
        this.logger.info("Writing test file", { slug });
        await writeFile(join(this.testsDir, `${slug}.md`), formatTestContent(name, prompt), "utf-8");
    }

    async writeSkill({ slug, name, description, content }: WriteSkillParams): Promise<void> {
        this.logger.info("Writing skill file", { slug });
        await writeFile(join(this.skillsDir, `${slug}.md`), formatSkillContent(name, description, content), "utf-8");
    }

    async readTests(): Promise<ExistingTestInfo[]> {
        this.logger.info("Reading test files");

        const files = await readdir(this.testsDir);
        const tests: ExistingTestInfo[] = [];

        for (const file of files) {
            if (!file.endsWith(".md")) continue;
            const raw = await readFile(join(this.testsDir, file), "utf-8");
            const slug = file.replace(".md", "");
            const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
            const name = frontmatter?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim() ?? slug;
            const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();

            tests.push({ id: `test-${slug}`, name, slug, prompt: body });
        }

        this.logger.info("Read test files", { count: tests.length });
        return tests;
    }

    async readSkills(): Promise<ExistingSkillInfo[]> {
        this.logger.info("Reading skill files");

        const files = await readdir(this.skillsDir);
        const skills: ExistingSkillInfo[] = [];

        for (const file of files) {
            if (!file.endsWith(".md")) continue;
            const raw = await readFile(join(this.skillsDir, file), "utf-8");
            const slug = file.replace(".md", "");
            const frontmatter = raw.match(/^---\n([\s\S]*?)\n---/);
            const name = frontmatter?.[1]?.match(/name:\s*(.+)/)?.[1]?.trim() ?? slug;
            const description = frontmatter?.[1]?.match(/description:\s*(.+)/)?.[1]?.trim() ?? "";
            const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();

            skills.push({ id: `skill-${slug}`, name, slug, description, content: body });
        }

        this.logger.info("Read skill files", { count: skills.length });
        return skills;
    }
}

function formatTestContent(name: string, prompt: string): string {
    return `---\nname: ${name}\n---\n\n${prompt}`;
}

function formatSkillContent(name: string, description: string, content: string): string {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}`;
}
