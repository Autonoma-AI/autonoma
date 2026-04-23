import { Badge, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { WarningIcon } from "@phosphor-icons/react/Warning";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { formatDate } from "lib/format";
import { ensureIssuesListData } from "lib/query/issues.queries";
import { trpc } from "lib/trpc";
import { Suspense } from "react";
import { useAppNavigate } from "../../-use-app-navigate";
import { useCurrentApplication } from "../../-use-current-application";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/issues/")({
  loader: ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    return ensureIssuesListData(context.queryClient, app.id);
  },
  component: IssuesPage,
});

const TH = "px-4 py-2.5 text-left font-mono text-2xs font-medium uppercase tracking-widest text-text-tertiary";

type BadgeVariant = "critical" | "high" | "warn" | "secondary";

const SEVERITY_BADGE: Record<string, BadgeVariant> = {
  critical: "critical",
  high: "high",
  medium: "warn",
  low: "secondary",
};

type CategoryBadgeVariant = "status-failed" | "outline";

const CATEGORY_BADGE: Record<string, CategoryBadgeVariant> = {
  application_bug: "status-failed",
  agent_error: "outline",
};

const CATEGORY_LABEL: Record<string, string> = {
  application_bug: "Application Bug",
  agent_error: "Agent Error",
};

function IssuesTable() {
  const app = useCurrentApplication();
  const appNavigate = useAppNavigate();
  const { data: issues } = useSuspenseQuery(
    trpc.issues.list.queryOptions({ applicationId: app.id }, { refetchInterval: 10000 }),
  );

  function handleRowClick(issueId: string) {
    void appNavigate({
      to: "/app/$appSlug/issues/$issueId",
      params: { issueId },
    });
  }

  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <WarningIcon size={14} className="text-text-tertiary" />
        <PanelTitle>All issues</PanelTitle>
        <span className="ml-auto font-mono text-2xs text-text-tertiary">{issues.length} total</span>
      </PanelHeader>

      <PanelBody className="overflow-auto p-0">
        <table className="w-full min-w-160 table-fixed text-sm">
          <thead className="sticky top-0 z-10 border-b border-border-dim bg-surface-base">
            <tr>
              <th className={`${TH} w-4/12`}>Title</th>
              <th className={`${TH} w-2/12`}>Category</th>
              <th className={`${TH} w-1/12`}>Confidence</th>
              <th className={`${TH} w-1/12`}>Severity</th>
              <th className={`${TH} w-2/12`}>Test name</th>
              <th className={`${TH} w-2/12`}>Created</th>
            </tr>
          </thead>
          <tbody>
            {issues.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-text-tertiary">
                  No issues found
                </td>
              </tr>
            )}
            {issues.map((issue) => (
              <tr
                key={issue.id}
                className="cursor-pointer border-b border-border-dim last:border-0 transition-colors hover:bg-surface-raised"
                onClick={() => handleRowClick(issue.id)}
              >
                <td className="px-4 py-2.5">
                  <span className="block truncate text-sm font-medium text-text-primary">{issue.title}</span>
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant={CATEGORY_BADGE[issue.category] ?? "outline"}>
                    {CATEGORY_LABEL[issue.category] ?? issue.category}
                  </Badge>
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
        <WarningIcon size={14} className="text-text-tertiary" />
        <PanelTitle>All issues</PanelTitle>
      </PanelHeader>
      <PanelBody className="p-4">
        <div className="flex flex-col gap-3">
          {["sk-1", "sk-2", "sk-3", "sk-4", "sk-5", "sk-6"].map((id) => (
            <Skeleton key={id} className="h-10 w-full" />
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}

function IssuesPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Issues</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">
          Review issues found during test generation analysis
        </p>
      </header>

      <Suspense fallback={<TableSkeleton />}>
        <IssuesTable />
      </Suspense>
    </div>
  );
}
