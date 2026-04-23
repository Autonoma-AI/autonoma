import {
  Badge,
  Button,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@autonoma/blacklight";
import { BugBeetleIcon } from "@phosphor-icons/react/BugBeetle";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { XIcon } from "@phosphor-icons/react/X";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { formatDate } from "lib/format";
import { ensureBugsListData, useConfirmBug, useDismissIssue } from "lib/query/bugs.queries";
import { trpc } from "lib/trpc";
import { Suspense } from "react";
import { useAppNavigate } from "../../-use-app-navigate";
import { useCurrentApplication } from "../../-use-current-application";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/bugs/")({
  loader: ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    return ensureBugsListData(context.queryClient, app.id);
  },
  component: BugsPage,
});

const TH = "px-4 py-2.5 text-left font-mono text-2xs font-medium uppercase tracking-widest text-text-tertiary";

type SeverityBadgeVariant = "critical" | "high" | "warn" | "secondary";

const SEVERITY_BADGE: Record<string, SeverityBadgeVariant> = {
  critical: "critical",
  high: "high",
  medium: "warn",
  low: "secondary",
};

type StatusBadgeVariant = "status-failed" | "success" | "warn";

const STATUS_BADGE: Record<string, StatusBadgeVariant> = {
  open: "status-failed",
  resolved: "success",
  regressed: "warn",
};

function BugsTable() {
  const app = useCurrentApplication();
  const appNavigate = useAppNavigate();
  const { data: bugs } = useSuspenseQuery(
    trpc.bugs.list.queryOptions({ applicationId: app.id }, { refetchInterval: 10000 }),
  );

  function handleRowClick(bugId: string) {
    void appNavigate({
      to: "/app/$appSlug/bugs/$bugId",
      params: { bugId },
    });
  }

  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <BugBeetleIcon size={14} className="text-text-tertiary" />
        <PanelTitle>All bugs</PanelTitle>
        <span className="ml-auto font-mono text-2xs text-text-tertiary">{bugs.length} total</span>
      </PanelHeader>

      <PanelBody className="overflow-auto p-0">
        <table className="w-full min-w-160 table-fixed text-sm">
          <thead className="sticky top-0 z-10 border-b border-border-dim bg-surface-base">
            <tr>
              <th className={`${TH} w-1/12`}>Status</th>
              <th className={`${TH} w-3/12`}>Title</th>
              <th className={`${TH} w-2/12`}>Test case</th>
              <th className={`${TH} w-1/12`}>Severity</th>
              <th className={`${TH} w-2/12`}>First seen</th>
              <th className={`${TH} w-2/12`}>Last seen</th>
              <th className={`${TH} w-1/12`}>Occurrences</th>
            </tr>
          </thead>
          <tbody>
            {bugs.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-sm text-text-tertiary">
                  No bugs tracked yet
                </td>
              </tr>
            )}
            {bugs.map((bug) => (
              <tr
                key={bug.id}
                className="cursor-pointer border-b border-border-dim last:border-0 transition-colors hover:bg-surface-raised"
                onClick={() => handleRowClick(bug.id)}
              >
                <td className="px-4 py-2.5">
                  <Badge variant={STATUS_BADGE[bug.status] ?? "secondary"}>{bug.status}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <span className="block truncate text-sm font-medium text-text-primary">{bug.title}</span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="block truncate text-sm text-text-secondary">{bug.testCase.name}</span>
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant={SEVERITY_BADGE[bug.severity] ?? "secondary"}>{bug.severity}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-sm text-text-secondary whitespace-nowrap">{formatDate(bug.firstSeenAt)}</span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-sm text-text-secondary whitespace-nowrap">{formatDate(bug.lastSeenAt)}</span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="font-mono text-sm text-text-secondary">{bug.occurrences}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </PanelBody>
    </Panel>
  );
}

function PendingReviewTable() {
  const app = useCurrentApplication();
  const { data: issues } = useSuspenseQuery(
    trpc.bugs.pendingReview.queryOptions({ applicationId: app.id }, { refetchInterval: 10000 }),
  );
  const confirmBug = useConfirmBug();
  const dismissIssue = useDismissIssue();

  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <PanelTitle>Pending review</PanelTitle>
        <span className="ml-auto font-mono text-2xs text-text-tertiary">{issues.length} pending</span>
      </PanelHeader>

      <PanelBody className="overflow-auto p-0">
        <table className="w-full min-w-160 table-fixed text-sm">
          <thead className="sticky top-0 z-10 border-b border-border-dim bg-surface-base">
            <tr>
              <th className={`${TH} w-4/12`}>Title</th>
              <th className={`${TH} w-1/12`}>Confidence</th>
              <th className={`${TH} w-1/12`}>Severity</th>
              <th className={`${TH} w-2/12`}>Test name</th>
              <th className={`${TH} w-2/12`}>Created</th>
              <th className={`${TH} w-2/12`}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {issues.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-text-tertiary">
                  No issues pending review
                </td>
              </tr>
            )}
            {issues.map((issue) => (
              <tr key={issue.id} className="border-b border-border-dim last:border-0">
                <td className="px-4 py-2.5">
                  <span className="block truncate text-sm font-medium text-text-primary">{issue.title}</span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="font-mono text-sm text-text-secondary">{issue.confidence}%</span>
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant={SEVERITY_BADGE[issue.severity] ?? "secondary"}>{issue.severity}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <span className="block truncate text-sm text-text-secondary">{issue.testName}</span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-sm text-text-secondary whitespace-nowrap">{formatDate(issue.createdAt)}</span>
                </td>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <Button
                      size="xs"
                      variant="default"
                      onClick={() => confirmBug.mutate({ issueId: issue.id })}
                      disabled={confirmBug.isPending}
                    >
                      <CheckIcon size={12} />
                      Confirm
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => dismissIssue.mutate({ issueId: issue.id })}
                      disabled={dismissIssue.isPending}
                    >
                      <XIcon size={12} />
                      Dismiss
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </PanelBody>
    </Panel>
  );
}

function TableSkeleton() {
  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <BugBeetleIcon size={14} className="text-text-tertiary" />
        <PanelTitle>All bugs</PanelTitle>
      </PanelHeader>
      <PanelBody className="p-4">
        <div className="flex flex-col gap-3">
          {["sk-1", "sk-2", "sk-3", "sk-4", "sk-5"].map((id) => (
            <Skeleton key={id} className="h-10 w-full" />
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}

function BugsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Bugs</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">Track application bugs across snapshots</p>
      </header>

      <Tabs defaultValue="bugs">
        <TabsList>
          <TabsTrigger value="bugs">Tracked Bugs</TabsTrigger>
          <TabsTrigger value="review">Pending Review</TabsTrigger>
        </TabsList>

        <TabsContent value="bugs" className="mt-4">
          <Suspense fallback={<TableSkeleton />}>
            <BugsTable />
          </Suspense>
        </TabsContent>

        <TabsContent value="review" className="mt-4">
          <Suspense fallback={<TableSkeleton />}>
            <PendingReviewTable />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
