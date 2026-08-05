/** Read-only: for each case, what durable catalog sources survive? twin snapshot / parent snapshot / main active snapshot. */
import { readFile } from "node:fs/promises";
import { db } from "@autonoma/db";

async function exists(snapshotId?: string): Promise<boolean> {
    if (snapshotId == null) return false;
    const s = await db.branchSnapshot.findUnique({ where: { id: snapshotId }, select: { id: true } });
    return s != null;
}

async function main(): Promise<void> {
    const casesPath = process.argv[2];
    if (casesPath == null) throw new Error("usage: eval-durable-probe.ts <cases.json>");
    const cases: { app: string; pr: number; repo: string; twin: string; parent: string }[] = JSON.parse(
        await readFile(casesPath, "utf8"),
    );
    for (const c of cases) {
        const twinOk = await exists(c.twin);
        const parentOk = await exists(c.parent);
        // Resolve the app's main branch active snapshot (durable customer data) as a fallback catalog source.
        const app = await db.application.findFirst({
            where: { slug: c.app },
            select: { id: true, mainBranch: { select: { activeSnapshotId: true } } },
        });
        const mainSnap = app?.mainBranch?.activeSnapshotId;
        const mainOk = await exists(mainSnap);
        console.log(
            `${c.app.padEnd(18)} #${String(c.pr).padEnd(6)} twin=${twinOk ? "OK " : "gone"} parent=${parentOk ? "OK " : "gone"} mainActive=${mainOk ? "OK" : "none"} (${mainSnap ?? "-"})`,
        );
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
