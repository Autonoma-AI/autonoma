const TEXT_FILE_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".md",
    ".mdx",
    ".txt",
    ".csv",
    ".html",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".py",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".swift",
    ".c",
    ".cpp",
    ".h",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".prisma",
    ".graphql",
    ".gql",
    ".sql",
]);

const TEXT_FILE_NAMES = new Set([".gitignore", ".dockerignore", "dockerfile", "containerfile", "makefile"]);
const TEXT_FILE_PREFIXES = ["dockerfile.", "containerfile.", "makefile."];

function getBaseName(filePath: string): string {
    const normalizedPath = filePath.replaceAll("\\", "/");
    const segments = normalizedPath.split("/");
    return segments[segments.length - 1]?.toLowerCase() ?? filePath.toLowerCase();
}

function isEnvironmentFile(baseName: string): boolean {
    return baseName === ".env" || baseName.startsWith(".env.");
}

function hasKnownTextFileName(baseName: string): boolean {
    if (TEXT_FILE_NAMES.has(baseName)) {
        return true;
    }

    return TEXT_FILE_PREFIXES.some((prefix) => baseName.startsWith(prefix));
}

export function isTextFile(filePath: string): boolean {
    const baseName = getBaseName(filePath);

    if (hasKnownTextFileName(baseName) || isEnvironmentFile(baseName)) {
        return true;
    }

    const lastDot = baseName.lastIndexOf(".");
    if (lastDot === -1) {
        return false;
    }

    const extension = baseName.slice(lastDot);
    return TEXT_FILE_EXTENSIONS.has(extension);
}
