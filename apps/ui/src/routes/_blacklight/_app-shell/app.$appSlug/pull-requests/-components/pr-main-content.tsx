import type { RouterOutputs } from "lib/trpc";
import { PRBodyCard } from "./pr-body-card";
import { PRCommitsTab } from "./pr-commits-tab";

type PullRequest = RouterOutputs["github"]["getPullRequest"];

export function PRMainContent({
  applicationId,
  prNumber,
  pr,
}: {
  applicationId: string;
  prNumber: number;
  pr: PullRequest | undefined;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PRBodyCard body={pr?.body} authorLogin={pr?.authorLogin} />
      <PRCommitsTab applicationId={applicationId} prNumber={prNumber} />
    </div>
  );
}
