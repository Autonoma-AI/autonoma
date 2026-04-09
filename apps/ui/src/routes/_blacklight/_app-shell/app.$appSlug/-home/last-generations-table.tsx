import { Badge, Panel, PanelBody, PanelHeader, PanelTitle } from "@autonoma/blacklight";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { useSuspenseQuery } from "@tanstack/react-query";
import { formatDate } from "lib/format";
import { trpc } from "lib/trpc";
import { AppLink } from "../../-app-link";
import { useCurrentApplication } from "../../-use-current-application";
import { toGenerationBadgeVariant, toGenerationStatusLabel } from "./helpers";

const TH = "px-4 py-2.5 text-left font-mono text-2xs font-medium uppercase tracking-widest text-text-tertiary";

export function LastGenerationsTable() {
  const app = useCurrentApplication();
  const { data: generations } = useSuspenseQuery(
    trpc.generations.list.queryOptions({ applicationId: app.id }, { refetchInterval: 5000 }),
  );

  const recent = generations.slice(0, 5);
  return (
    <Panel className="flex flex-1 flex-col overflow-hidden">
      <PanelHeader className="flex items-center gap-2">
        <LightningIcon size={14} className="text-text-tertiary" />
        <PanelTitle>Last generations</PanelTitle>
        <span className="ml-auto font-mono text-2xs text-text-tertiary">{generations.length} total</span>
      </PanelHeader>

      <PanelBody className="flex-1 overflow-auto p-0">
        <table className="w-full min-w-130 table-fixed text-sm">
          <thead className="sticky top-0 z-10 border-b border-border-dim bg-surface-base">
            <tr>
              <th className={`${TH} w-5/12`}>Test name</th>
              <th className={`${TH} w-2/12`}>Steps</th>
              <th className={`${TH} w-2/12`}>Status</th>
              <th className={`${TH} w-3/12`}>Created</th>
            </tr>
          </thead>
          <tbody>
            {recent.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-sm text-text-tertiary">
                  No generations yet - run your first one!
                </td>
              </tr>
            )}
            {recent.map((gen) => (
              <AppLink
                key={gen.id}
                to="/app/$appSlug/generations/$generationId"
                params={{ generationId: gen.id }}
                className="table-row cursor-pointer border-b border-border-dim last:border-0 transition-colors hover:bg-surface-raised"
              >
                <td className="px-4 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-text-primary">{gen.testName}</span>
                    <span className="font-mono text-2xs text-text-tertiary">{gen.shortId}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-sm text-text-secondary">{gen.stepCount}</span>
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant={toGenerationBadgeVariant(gen.status)}>{toGenerationStatusLabel(gen.status)}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-sm text-text-secondary whitespace-nowrap">{formatDate(gen.createdAt)}</span>
                </td>
              </AppLink>
            ))}
          </tbody>
        </table>
      </PanelBody>
    </Panel>
  );
}

export function LastGenerationsTableSkeleton() {
  return (
    <Panel className="flex flex-1 flex-col">
      <PanelHeader className="flex items-center gap-2">
        <LightningIcon size={14} className="text-text-tertiary" />
        <PanelTitle>Last generations</PanelTitle>
      </PanelHeader>
      <PanelBody className="flex-1 p-4">
        <div className="flex flex-col gap-3">
          {["sk-1", "sk-2", "sk-3", "sk-4", "sk-5"].map((id) => (
            <div key={id} className="h-10 animate-pulse bg-surface-raised" />
          ))}
        </div>
      </PanelBody>
    </Panel>
  );
}
