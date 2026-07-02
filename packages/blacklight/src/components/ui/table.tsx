import { ArrowDown } from "@phosphor-icons/react/ArrowDown";
import { ArrowsDownUp } from "@phosphor-icons/react/ArrowsDownUp";
import { ArrowUp } from "@phosphor-icons/react/ArrowUp";
import {
  type Column,
  type ColumnDef,
  type Header,
  type Row,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { cn } from "../../lib/utils";

/** Props the table computes for each row; spread them onto the row element (e.g. an AppLink). */
interface RowProps {
  className: string;
  style: CSSProperties;
  role: "row";
  /** Present only when virtualized: lets the virtualizer measure the row's real height. */
  ref?: (node: HTMLElement | null) => void;
  /** Present only when virtualized: the row's flat index, required for dynamic measurement. */
  "data-index"?: number;
}

interface RenderRowProps {
  rowProps: RowProps;
  children: ReactNode;
}

interface SortableTableProps<TData> {
  data: TData[];
  columns: ColumnDef<TData, unknown>[];
  onRowClick?: (row: TData) => void;
  renderRow?: (row: TData, props: RenderRowProps) => ReactNode;
  emptyMessage?: string;
  className?: string;
  /**
   * Render only the rows currently in view (TanStack Virtual). The scroll
   * container is this component's root element, so its parent must give it a
   * bounded height (e.g. `flex-1 min-h-0`). Row heights are measured
   * dynamically, so variable-height rows (wrapping tags, thumbnails) are fine.
   */
  virtualized?: boolean;
  /** Estimated row height in px, used before a row is measured. Only used when `virtualized`. */
  estimatedRowHeight?: number;
}

/**
 * Sortable, optionally virtualized table. Rows are laid out with CSS grid (one
 * `grid-template-columns` shared by the header and every row) rather than real
 * `<table>` markup, so the same renderer works whether or not rows are
 * virtualized. ARIA grid roles are applied to keep it accessible.
 */
function SortableTable<TData>({
  data,
  columns,
  onRowClick,
  renderRow,
  emptyMessage = "No data",
  className,
  virtualized = false,
  estimatedRowHeight = 53,
}: SortableTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (virtualized) {
    return (
      <VirtualizedTable
        table={table}
        renderRow={renderRow}
        onRowClick={onRowClick}
        emptyMessage={emptyMessage}
        className={className}
        estimatedRowHeight={estimatedRowHeight}
      />
    );
  }

  const gridTemplateColumns = buildGridTemplate(table.getVisibleLeafColumns());
  const rows = table.getRowModel().rows;
  const interactive = onRowClick != null || renderRow != null;

  return (
    <div role="table" data-slot="sortable-table" className={cn("overflow-auto text-sm", className)}>
      <TableHeader table={table} gridTemplateColumns={gridTemplateColumns} />
      {rows.length === 0 ? (
        <EmptyRow message={emptyMessage} />
      ) : (
        <div role="rowgroup">
          {rows.map((row) => renderBodyRow({ row, gridTemplateColumns, interactive, onRowClick, renderRow }))}
        </div>
      )}
    </div>
  );
}

interface VirtualizedTableProps<TData> {
  table: ReturnType<typeof useReactTable<TData>>;
  renderRow?: (row: TData, props: RenderRowProps) => ReactNode;
  onRowClick?: (row: TData) => void;
  emptyMessage: string;
  className?: string;
  estimatedRowHeight: number;
}

function VirtualizedTable<TData>({
  table,
  renderRow,
  onRowClick,
  emptyMessage,
  className,
  estimatedRowHeight,
}: VirtualizedTableProps<TData>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const rows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => estimatedRowHeight,
    overscan: 8,
  });

  const gridTemplateColumns = buildGridTemplate(table.getVisibleLeafColumns());
  const interactive = onRowClick != null || renderRow != null;

  return (
    <div
      ref={scrollRef}
      role="table"
      data-slot="sortable-table"
      className={cn("h-full overflow-auto text-sm", className)}
    >
      <TableHeader table={table} gridTemplateColumns={gridTemplateColumns} />
      {rows.length === 0 ? (
        <EmptyRow message={emptyMessage} />
      ) : (
        <div role="rowgroup" className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const row = rows[virtualRow.index];
            if (row == null) return undefined;
            return renderBodyRow({
              row,
              gridTemplateColumns,
              interactive,
              onRowClick,
              renderRow,
              virtualStart: virtualRow.start,
              index: virtualRow.index,
              measureRef: virtualizer.measureElement,
            });
          })}
        </div>
      )}
    </div>
  );
}

interface RenderBodyRowOptions<TData> {
  row: Row<TData>;
  gridTemplateColumns: string;
  interactive: boolean;
  onRowClick?: (row: TData) => void;
  renderRow?: (row: TData, props: RenderRowProps) => ReactNode;
  /** Provided only when virtualized: absolute offset of the row within the list. */
  virtualStart?: number;
  index?: number;
  measureRef?: (node: HTMLElement | null) => void;
}

function renderBodyRow<TData>(options: RenderBodyRowOptions<TData>): ReactNode {
  const { row, gridTemplateColumns, interactive, onRowClick, renderRow, virtualStart, index, measureRef } = options;
  const isVirtual = virtualStart != null;

  const rowProps: RowProps = {
    role: "row",
    className: cn(
      "grid border-b border-border-dim transition-colors hover:bg-surface-raised",
      !isVirtual && "last:border-0",
      interactive && "cursor-pointer",
    ),
    style: isVirtual ? virtualRowStyle(gridTemplateColumns, virtualStart) : { gridTemplateColumns },
    ref: measureRef,
    "data-index": index,
  };

  const cells = row.getVisibleCells().map((cell) => (
    <div key={cell.id} role="cell" data-slot="sortable-table-cell" className="flex min-w-0 items-center px-4 py-2.5">
      {flexRender(cell.column.columnDef.cell, cell.getContext())}
    </div>
  ));

  if (renderRow != null) {
    return renderRow(row.original, { rowProps, children: cells });
  }

  return (
    <div
      key={row.id}
      data-slot="sortable-table-row"
      {...rowProps}
      onClick={onRowClick != null ? () => onRowClick(row.original) : undefined}
    >
      {cells}
    </div>
  );
}

function TableHeader<TData>({
  table,
  gridTemplateColumns,
}: {
  table: ReturnType<typeof useReactTable<TData>>;
  gridTemplateColumns: string;
}) {
  return (
    <div
      role="row"
      className="sticky top-0 z-10 grid border-b border-border-dim bg-surface-base"
      style={{ gridTemplateColumns }}
    >
      {table
        .getHeaderGroups()
        .map((headerGroup) => headerGroup.headers.map((header) => <HeaderCell key={header.id} header={header} />))}
    </div>
  );
}

function HeaderCell<TData>({ header }: { header: Header<TData, unknown> }) {
  const canSort = header.column.getCanSort();
  const sorted = header.column.getIsSorted();
  return (
    <div
      role="columnheader"
      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
      data-slot="sortable-table-header"
      className={cn(
        "flex items-center px-4 py-2.5 font-mono text-2xs font-medium uppercase tracking-widest text-text-secondary",
        canSort && "cursor-pointer select-none transition-colors hover:text-text-primary",
      )}
      onClick={header.column.getToggleSortingHandler()}
    >
      <span className="inline-flex items-center gap-1.5">
        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
        {canSort && <SortIndicator sorted={sorted} />}
      </span>
    </div>
  );
}

function SortIndicator({ sorted }: { sorted: false | "asc" | "desc" }) {
  return (
    <span className="text-text-secondary">
      {sorted === "asc" && <ArrowUp size={12} />}
      {sorted === "desc" && <ArrowDown size={12} />}
      {sorted === false && <ArrowsDownUp size={10} className="opacity-40" />}
    </span>
  );
}

function EmptyRow({ message }: { message: string }) {
  return <div className="px-4 py-10 text-center text-sm text-text-secondary">{message}</div>;
}

function virtualRowStyle(gridTemplateColumns: string, start: number): CSSProperties {
  return {
    position: "absolute",
    top: 0,
    left: 0,
    width: "100%",
    transform: `translateY(${start}px)`,
    gridTemplateColumns,
  };
}

/**
 * Each column becomes `minmax(<size>px, <size>fr)` so columns keep their size as
 * a minimum and share any extra width proportionally - mirroring the
 * `table-fixed w-full` behavior of a native table.
 */
function buildGridTemplate<TData>(columns: Column<TData, unknown>[]): string {
  return columns
    .map((column) => {
      const size = column.getSize();
      return `minmax(${size}px, ${size}fr)`;
    })
    .join(" ");
}

export { SortableTable, type SortableTableProps };
export type { ColumnDef, SortingState } from "@tanstack/react-table";
