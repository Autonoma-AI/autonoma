/** Preflight for the proposal eval: confirm each twin snapshot still exists + has base/head SHAs. Read-only. */
import { readFile } from "node:fs/promises";
import { db } from "@autonoma/db";

async function main(): Promise<void> {
    const casesPath = process.argv[2];
    if (casesPath == null) throw new Error("usage: eval-preflight.ts <cases.json>");
    const cases: { app: string; pr: number; twin: string }[] = JSON.parse(await readFile(casesPath, "utf8"));
    let alive = 0;
    for (const c of cases) {
        const s = await db.branchSnapshot.findUnique({
            where: { id: c.twin },
            select: { id: true, baseSha: true, headSha: true },
        });
        const ok = s != null && s.baseSha != null && s.headSha != null;
        if (ok) alive++;
        console.error(`  ${ok ? "OK " : "MISSING"} ${c.app.padEnd(18)} #${String(c.pr).padEnd(6)} ${c.twin}`);
    }
    console.error(`\n${alive}/${cases.length} twin snapshots resolvable`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
