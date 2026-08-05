import type { RouterOutputs } from "lib/trpc";

export type SnapshotDetail = RouterOutputs["branches"]["snapshotDetail"];
export type CreatedTest = SnapshotDetail["createdTests"][number];
export type SnapshotChange = SnapshotDetail["changes"][number];
