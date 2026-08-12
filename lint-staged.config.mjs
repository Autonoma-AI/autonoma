// `prisma format` takes a single `--schema`: given several paths it formats the first
// and silently ignores the rest. lint-staged appends every matched file to one command
// string, so the schemas have to be mapped to one invocation each - which is why this
// config is a file rather than a `lint-staged` block in package.json.
export default {
    "*.{ts,tsx,js,jsx}": ["oxlint --fix", "oxfmt --write"],
    "*.{json,jsonc}": ["oxfmt --write"],
    "*.prisma": (files) => files.map((file) => `prisma format --schema "${file}"`),
};
