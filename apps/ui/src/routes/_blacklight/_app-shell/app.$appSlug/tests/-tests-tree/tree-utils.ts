import type { ChildNode, FolderNode, FolderRecord, TestCaseRecord } from "./tree-types";

export function buildTree(folders: FolderRecord[], testCases: TestCaseRecord[]): ChildNode[] {
    const folderMap = new Map<string, FolderNode>();
    for (const f of folders) {
        folderMap.set(f.id, { ...f, children: [] });
    }

    for (const f of folders) {
        if (f.parentId != null) {
            const parent = folderMap.get(f.parentId);
            const child = folderMap.get(f.id);
            if (parent != null && child != null) {
                parent.children.push(child);
            }
        }
    }

    for (const tc of testCases) {
        const folder = folderMap.get(tc.folderId);
        if (folder != null) {
            folder.children.push(tc);
        }
    }

    const roots: ChildNode[] = [];
    for (const f of folders) {
        if (f.parentId == null) {
            const node = folderMap.get(f.id);
            if (node != null) roots.push(node);
        }
    }

    return roots;
}

export function filterChildren(children: ChildNode[], lower: string): ChildNode[] {
    const result: ChildNode[] = [];
    for (const child of children) {
        if ("children" in child) {
            const folderNameMatches = child.name.toLowerCase().includes(lower);
            const filteredKids = filterChildren(child.children, lower);
            if (folderNameMatches || filteredKids.length > 0) {
                const kids = folderNameMatches ? child.children : filteredKids;
                result.push({ ...child, children: kids });
            }
        } else {
            if (child.name.toLowerCase().includes(lower)) {
                result.push(child);
            }
        }
    }
    return result;
}

export function collectDescendantTests(node: FolderNode): TestCaseRecord[] {
    const tests: TestCaseRecord[] = [];
    for (const child of node.children) {
        if ("children" in child) {
            tests.push(...collectDescendantTests(child));
        } else {
            tests.push(child);
        }
    }
    return tests;
}

export function collectAllFolderIds(children: ChildNode[]): string[] {
    const ids: string[] = [];
    for (const child of children) {
        if ("children" in child) {
            ids.push(child.id);
            ids.push(...collectAllFolderIds(child.children));
        }
    }
    return ids;
}
