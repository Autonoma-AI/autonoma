import type { RouterOutputs } from "lib/trpc";

export type FolderRecord = RouterOutputs["folders"]["list"][number];

export interface TestCaseRecord {
    id: string;
    name: string;
    slug: string;
    folderId: string;
}

export type FolderNode = FolderRecord & { children: ChildNode[] };
export type ChildNode = FolderNode | TestCaseRecord;
