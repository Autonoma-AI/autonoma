import { Skeleton } from "@autonoma/blacklight";
import type { BugVerdict } from "@autonoma/types";
import { createFileRoute } from "@tanstack/react-router";
import { BugHeadline } from "components/bugs/bug-headline";
import { BugHeroMedia } from "components/bugs/bug-hero-media";
import { BugMetaStrip } from "components/bugs/bug-meta-strip";
import { BugReproduction } from "components/bugs/bug-reproduction";
import { BugSuspectedCause } from "components/bugs/bug-suspected-cause";
import { BugWhySection } from "components/bugs/bug-why-section";
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

  const classificationEnabled = isAdmin && classification?.enabled === true;

  return (
    <div className="flex flex-col gap-6">
      <BugHeadline
        bug={bug}
        onToggleResolved={toggleResolved}
        togglingResolved={resolveBug.isPending || reopenBug.isPending}
        classification={
          classificationEnabled ? { verdict, onClassify: classify, classifying: classifyBug.isPending } : undefined
        }
      />
      <BugMetaStrip bug={bug} />

      {/* Report-driven section slots, filled by later slices of the redesign (#1269). */}
      <BugHeroMedia hero={bug.hero} />
      <BugWhySection report={bug.report} />
      <BugSuspectedCause />

      <BugReproduction latest={bug.latestOccurrence} />
    </div>
  );
}

function BugDetailSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-8 w-96" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-10 w-full" />
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
