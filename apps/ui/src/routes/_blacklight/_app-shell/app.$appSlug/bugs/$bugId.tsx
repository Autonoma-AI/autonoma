import { Button, Skeleton } from "@autonoma/blacklight";
import type { BugVerdict } from "@autonoma/types";
import { ThumbsDownIcon } from "@phosphor-icons/react/ThumbsDown";
import { ThumbsUpIcon } from "@phosphor-icons/react/ThumbsUp";
import { createFileRoute } from "@tanstack/react-router";
import { BugDetailHeader } from "components/bugs/bug-detail-header";
import { BugEvidenceScreenshot } from "components/bugs/bug-evidence-screenshot";
import { BugQuickActions } from "components/bugs/bug-quick-actions";
import { OccurrencesRail } from "components/bugs/occurrences-rail";
import { ReproductionSteps } from "components/bugs/reproduction-steps";
import { useAuth } from "lib/auth";
import {
  ensureBugDetailData,
  useBugDetail,
  useClassificationEnabled,
  useClassifyBug,
  useReopenBug,
  useResolveBug,
} from "lib/query/bugs.queries";
import { Suspense, useState } from "react";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/bugs/$bugId")({
  loader: ({ context, params: { bugId } }) => {
    return ensureBugDetailData(context.queryClient, bugId);
  },
  component: BugDetailPage,
});

function BugDetail() {
  const { bugId } = Route.useParams();
  const { isAdmin } = useAuth();
  const { data: bug } = useBugDetail(bugId);
  const resolveBug = useResolveBug(bugId);
  const reopenBug = useReopenBug(bugId);
  const classifyBug = useClassifyBug();
  const { data: classification } = useClassificationEnabled(isAdmin);
  const [verdict, setVerdict] = useState<BugVerdict | undefined>(undefined);

  function classify(value: BugVerdict) {
    setVerdict(value);
    classifyBug.mutate({ bugId, verdict: value });
  }

  function toggleResolved() {
    if (bug.status === "resolved") {
      reopenBug.mutate({ bugId });
      return;
    }
    resolveBug.mutate({ bugId });
  }

  const adminActions =
    isAdmin && classification?.enabled === true ? (
      <>
        <Button
          size="sm"
          variant={verdict === "true_positive" ? "default" : "ghost"}
          onClick={() => classify("true_positive")}
          disabled={classifyBug.isPending}
        >
          <ThumbsUpIcon size={14} />
          True positive
        </Button>
        <Button
          size="sm"
          variant={verdict === "false_positive" ? "default" : "ghost"}
          onClick={() => classify("false_positive")}
          disabled={classifyBug.isPending}
        >
          <ThumbsDownIcon size={14} />
          False positive
        </Button>
      </>
    ) : undefined;

  return (
    <div className="flex flex-col gap-6">
      <BugDetailHeader
        bug={bug}
        onToggleResolved={toggleResolved}
        togglingResolved={resolveBug.isPending || reopenBug.isPending}
        adminActions={adminActions}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <main className="min-w-0 space-y-6">
          <BugEvidenceScreenshot latest={bug.latestOccurrence} bugDescription={bug.description} />
          <ReproductionSteps latest={bug.latestOccurrence} />
        </main>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:self-start">
          <OccurrencesRail bug={bug} />
          <BugQuickActions bug={bug} />
        </aside>
      </div>
    </div>
  );
}

function BugDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-96" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-52" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Skeleton className="h-120 w-full" />
          <Skeleton className="h-72 w-full" />
        </div>
        <div className="space-y-4">
          <Skeleton className="h-80 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      </div>
    </div>
  );
}

function BugDetailPage() {
  return (
    <Suspense fallback={<BugDetailSkeleton />}>
      <BugDetail />
    </Suspense>
  );
}
