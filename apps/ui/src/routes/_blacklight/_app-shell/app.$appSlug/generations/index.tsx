import { Badge, Button, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useAuth } from "lib/auth";
import { formatDate } from "lib/format";
import { ensureGenerationsListData } from "lib/query/generations.queries";
import { trpc } from "lib/trpc";
import { useState } from "react";
import { toGenerationBadgeVariant, toGenerationStatusLabel } from "../-home/helpers";
import { useAppNavigate } from "../../-use-app-navigate";
import { useCurrentApplication } from "../../-use-current-application";
import { DeleteGenerationDialog } from "./-delete-generation-dialog";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/generations/")({
  loader: ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    return ensureGenerationsListData(context.queryClient, app.id);
  },
  component: GenerationsPage,
  pendingComponent: TableSkeleton,
});

const TH = "px-4 py-2.5 text-left font-mono text-2xs font-medium uppercase tracking-widest text-text-tertiary";

function GenerationsTable() {
  const app = useCurrentApplication();
  const appNavigate = useAppNavigate();
  const { isAdmin } = useAuth();
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | undefined>(undefined);
  const { data: generations } = useSuspenseQuery(
    trpc.generations.list.queryOptions({ applicationId: app.id }, { refetchInterval: 5000 }),
  );

  function handleRowClick(id: string) {
    void appNavigate({
      to: "/app/$appSlug/generations/$generationId",
      params: { generationId: id },
    });
  }

  function handleDeleteClick(e: React.MouseEvent, id: string, name: string) {
    e.stopPropagation();
    setDeleteTarget({ id, name });
  }

  const colSpan = isAdmin ? 5 : 4;

  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <LightningIcon size={14} className="text-text-tertiary" />
        <PanelTitle>All generations</PanelTitle>
        <span className="ml-auto font-mono text-2xs text-text-tertiary">{generations.length} total</span>
      </PanelHeader>

      <PanelBody className="overflow-auto p-0">
        <table className="w-full min-w-130 table-fixed text-sm">
          <thead className="sticky top-0 z-10 border-b border-border-dim bg-surface-base">
            <tr>
              <th className={`${TH} w-5/12`}>Test name</th>
              <th className={`${TH} w-2/12`}>Status</th>
              <th className={`${TH} w-2/12`}>Steps</th>
              <th className={`${TH} ${isAdmin ? "w-2/12" : "w-3/12"}`}>Created</th>
              {isAdmin && <th className={`${TH} w-1/12`} />}
            </tr>
          </thead>
          <tbody>
            {generations.length === 0 && (
              <tr>
                <td colSpan={colSpan} className="px-4 py-10 text-center text-sm text-text-tertiary">
                  No generations yet - run your first one!
                </td>
              </tr>
            )}
            {generations.map((gen) => (
              <tr
                key={gen.id}
                className="cursor-pointer border-b border-border-dim last:border-0 transition-colors hover:bg-surface-raised"
                onClick={() => handleRowClick(gen.id)}
              >
                <td className="px-4 py-2.5">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate text-sm font-medium text-text-primary">{gen.testName}</span>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-2xs text-text-tertiary">{gen.shortId}</span>
                      {gen.tags.length > 0 &&
                        gen.tags.map((tag) => (
                          <Badge key={tag} variant="outline" className="text-2xs">
                            {tag}
                          </Badge>
                        ))}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-2.5">
                  <Badge variant={toGenerationBadgeVariant(gen.status)}>{toGenerationStatusLabel(gen.status)}</Badge>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-sm text-text-secondary">{gen.stepCount}</span>
                </td>
                <td className="px-4 py-2.5">
                  <span className="text-sm text-text-secondary whitespace-nowrap">{formatDate(gen.createdAt)}</span>
                </td>
                {isAdmin && (
                  <td className="px-4 py-2.5 text-right">
                    <Button variant="ghost" size="icon-xs" onClick={(e) => handleDeleteClick(e, gen.id, gen.testName)}>
                      <TrashIcon size={14} className="text-text-tertiary" />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </PanelBody>

      {deleteTarget != null && (
        <DeleteGenerationDialog
          open={deleteTarget != null}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(undefined);
          }}
          generationId={deleteTarget.id}
          generationName={deleteTarget.name}
        />
      )}
    </Panel>
  );
}

function TableSkeleton() {
  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <LightningIcon size={14} className="text-text-tertiary" />
        <PanelTitle>All generations</PanelTitle>
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

function GenerationsPage() {
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Generations</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">View and manage all test generations</p>
      </header>

      <GenerationsTable />
    </div>
  );
}
