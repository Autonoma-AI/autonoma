import { ArrowDown } from "@phosphor-icons/react/ArrowDown";
import { ArrowsDownUp } from "@phosphor-icons/react/ArrowsDownUp";
import { ArrowUp } from "@phosphor-icons/react/ArrowUp";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { type ReactNode, useState } from "react";
import { cn } from "../../lib/utils";

interface SortableTableProps<TData> {
  data: TData[];
  columns: ColumnDef<TData, unknown>[];
  onRowClick?: (row: TData) => void;
  renderRow?: (row: TData, props: { className: string; children: ReactNode }) => ReactNode;
  emptyMessage?: string;
  className?: string;
}

function SortableTable<TData>({
  data,
  columns,
  onRowClick,
  renderRow,
  emptyMessage = "No data",
  className,
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

  return (
    <div data-slot="sortable-table" className={cn("overflow-auto", className)}>
      <table className="w-full table-fixed text-sm">
        <thead className="sticky top-0 z-10 border-b border-border-dim bg-surface-base">
          {table.getHeaderGroups().map((headerGroup) => (
            <tr key={headerGroup.id}>
              {headerGroup.headers.map((header) => {
                const canSort = header.column.getCanSort();
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    data-slot="sortable-table-header"
                    className={cn(
                      "px-4 py-2.5 text-left font-mono text-2xs font-medium uppercase tracking-widest text-text-tertiary",
                      canSort && "cursor-pointer select-none transition-colors hover:text-text-secondary",
                    )}
                    style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                    onClick={header.column.getToggleSortingHandler()}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      {canSort && (
                        <span className="text-text-tertiary">
                          {sorted === "asc" && <ArrowUp size={12} />}
                          {sorted === "desc" && <ArrowDown size={12} />}
                          {sorted === false && <ArrowsDownUp size={10} className="opacity-40" />}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center text-sm text-text-tertiary">
                {emptyMessage}
              </td>
            </tr>
          )}
          {table.getRowModel().rows.map((row) => {
            const rowClassName = cn(
              "border-b border-border-dim last:border-0 transition-colors hover:bg-surface-raised",
              (onRowClick != null || renderRow != null) && "cursor-pointer",
            );
            const cells = row.getVisibleCells().map((cell) => (
              <td key={cell.id} data-slot="sortable-table-cell" className="px-4 py-2.5 align-middle">
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </td>
            ));

            if (renderRow != null) {
              return renderRow(row.original, { className: rowClassName, children: cells });
            }

            return (
              <tr
                key={row.id}
                data-slot="sortable-table-row"
                className={rowClassName}
                onClick={onRowClick != null ? () => onRowClick(row.original) : undefined}
              >
                {cells}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export { SortableTable, type SortableTableProps };
export type { ColumnDef, SortingState } from "@tanstack/react-table";
