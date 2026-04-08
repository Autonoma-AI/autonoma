import { useBranchDetail } from "lib/query/branches.queries";
import { useCurrentApplication } from "../-use-current-application";

export function useMainBranch() {
    const app = useCurrentApplication();
    return useBranchDetail(app.id, app.mainBranch.name).data;
}

export function useCurrentSnapshot() {
    const branch = useMainBranch();
    return branch.activeSnapshot;
}
