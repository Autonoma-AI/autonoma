import {
  Badge,
  Button,
  type ColumnDef,
  Input,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Skeleton,
  SortableTable,
} from "@autonoma/blacklight";
import { LightningIcon } from "@phosphor-icons/react/Lightning";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { createFileRoute } from "@tanstack/react-router";
import { formatDate } from "lib/format";
import { ensureGenerationsListData, useGenerations } from "lib/query/generations.queries";
import { useState } from "react";
import { toGenerationBadgeVariant, toGenerationStatusLabel } from "../-home/helpers";
import { AppLink } from "../../-app-link";
import { DeleteGenerationDialog } from "../generations/-delete-generation-dialog";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/admin/generations")({
  loader: ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    return ensureGenerationsListData(context.queryClient, app.id);
  },
  component: GenerationsPage,
  pendingComponent: TableSkeleton,
});

type GenerationItem = ReturnType<typeof useGenerations>["data"][number];

function GenerationsTable() {
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | undefined>(undefined);
  const [search, setSearch] = useState("");
  const { data: generations } = useGenerations();

  const query = search.trim().toLowerCase();
  const filteredGenerations =
    query === "" ? generations : generations.filter((gen) => gen.testName.toLowerCase().includes(query));

  function handleDeleteClick(e: React.MouseEvent, id: string, name: string) {
    e.preventDefault();
    e.stopPropagation();
    setDeleteTarget({ id, name });
  }

  const columns: ColumnDef<GenerationItem, unknown>[] = [
    {
      id: "name",
      accessorKey: "testName",
      header: "Test name",
      size: 400,
      enableSorting: true,
      cell: ({ row }) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-text-primary">{row.original.testName}</span>
          <div className="flex items-center gap-2">
            <span className="font-mono text-2xs text-text-secondary">{row.original.shortId}</span>
            {row.original.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-2xs">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
      ),
    },
    {
      id: "status",
      accessorKey: "status",
      header: "Status",
      size: 140,
      enableSorting: true,
      cell: ({ row }) => (
        <Badge variant={toGenerationBadgeVariant(row.original.status)}>
          {toGenerationStatusLabel(row.original.status)}
        </Badge>
      ),
    },
    {
      id: "steps",
      accessorKey: "stepCount",
      header: "Steps",
      size: 100,
      enableSorting: true,
      cell: ({ row }) => <span className="text-sm text-text-secondary">{row.original.stepCount}</span>,
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: "Created",
      size: 160,
      enableSorting: true,
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-sm text-text-secondary">{formatDate(row.original.createdAt)}</span>
      ),
    },
    {
      id: "actions",
      header: "",
      size: 60,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex w-full justify-end">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={(e) => handleDeleteClick(e, row.original.id, row.original.testName)}
          >
            <TrashIcon size={14} className="text-text-secondary" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Panel className="min-h-0 flex-1">
        <PanelHeader className="flex items-center gap-2">
          <LightningIcon size={14} className="text-text-secondary" />
          <PanelTitle>All generations</PanelTitle>
          <span className="ml-auto whitespace-nowrap font-mono text-2xs tabular-nums text-text-secondary">
            {filteredGenerations.length} total
          </span>
          <div className="relative w-64 max-w-full">
            <MagnifyingGlassIcon
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-secondary"
            />
            <Input
              type="search"
              placeholder="Filter by name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 pl-8 text-sm"
            />
          </div>
        </PanelHeader>

        <PanelBody className="min-h-0 flex-1 overflow-hidden p-0">
          <SortableTable
            virtualized
            estimatedRowHeight={53}
            data={filteredGenerations}
            columns={columns}
            renderRow={(gen, { rowProps, children }) => (
              <AppLink
                key={gen.id}
                to="/app/$appSlug/generations/$generationId"
                params={{ generationId: gen.id }}
                {...rowProps}
              >
                {children}
              </AppLink>
            )}
            emptyMessage={query === "" ? "No generations yet." : "No generations match your filter."}
          />
        </PanelBody>
      </Panel>

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
    </div>
  );
}

function TableSkeleton() {
  return (
    <Panel>
      <PanelHeader className="flex items-center gap-2">
        <LightningIcon size={14} className="text-text-secondary" />
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
    <div className="flex h-full min-h-0 flex-col gap-6 p-6 lg:p-8">
      <header>
        <h1 className="text-2xl font-medium tracking-tight text-text-primary">Generations</h1>
        <p className="mt-1 font-mono text-xs text-text-secondary">Admin-only: every generation for this app.</p>
      </header>

      <GenerationsTable />
    </div>
  );
}
