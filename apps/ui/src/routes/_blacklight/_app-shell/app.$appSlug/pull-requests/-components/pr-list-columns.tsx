import type { ColumnDef } from "@autonoma/blacklight";
import { PrStatusPill } from "components/pr-status/pr-status-pill";
import type { PreviewLivenessState } from "lib/query/preview-access.queries";
import { PRActivityCell, PRAuthorCell, PRNameCell } from "./pr-info-cells";
import { PRPreviewCell } from "./pr-preview-cell";
import type { PullRequestRow } from "./pull-request-row";

const PR_NUMBER_WIDTH = 72;
const AUTHOR_WIDTH = 130;
const PREVIEW_WIDTH = 140;
const ACTIVITY_WIDTH = 130;

/**
 * The one column with slack in it, so it absorbs what the standing rail costs.
 *
 * `buildGridTemplate` emits `minmax(floor, Nfr)`, and CSS grid compresses *below* the floor once the floors
 * add up to more than the track - so one column over budget truncates every column, including the verdicts
 * this file sizes so carefully. With the main-branch rail permanent, the table gets the content width less
 * 340px of rail and 24px of gap: 1012px at a 1440 viewport, against 72 + 130 + 140 + 130 + 168 = 640 for the
 * other five. That leaves 372, and this sits under it.
 */
const NAME_WIDTH = 360;

/**
 * Wide enough that the longest verdict survives at the column's floor.
 *
 * `buildGridTemplate` turns a column size into `minmax(Npx, Nfr)` - a floor plus a proportional share, never a
 * cap - so the floor is exactly this number and is what has to fit. Measured rather than estimated: the longest
 * labels the server can emit are "Checkpoint failed" and "No tests affected", and both render at 102px in the
 * badge's mono type. Around that go the tone dot and its gap (10px), the badge's own `px-2` and border (18px),
 * and the cell's `px-4` (32px) - 162px, so this is the next size up from it.
 *
 * The dot is the part an earlier estimate missed, which is how 160 shipped and clipped "No tests affected" by a
 * couple of pixels. Re-measure rather than re-derive if the badge's type scale or padding changes.
 */
const HEALTH_WIDTH = 168;

interface PrListColumnsOptions {
  /**
   * Whether any row on this page has a preview to link to.
   *
   * A closed pull request's environment is torn down, and the server only returns a URL for one that is
   * still standing - so on the Closed tab the column is empty in every row. Rather than a header over
   * twenty-five blanks, it is simply not a column. The same rule covers merged pull requests and
   * applications that never configured previews at all.
   */
  hasPreviews: boolean;
  liveness?: Record<string, PreviewLivenessState>;
}

/** The list's columns: every fact about a pull request gets its own, so a row scans as a line. */
export function prListColumns({ hasPreviews, liveness }: PrListColumnsOptions): ColumnDef<PullRequestRow, unknown>[] {
  const columns: ColumnDef<PullRequestRow, unknown>[] = [
    {
      id: "prNumber",
      accessorKey: "prNumber",
      header: "PR",
      size: PR_NUMBER_WIDTH,
      enableSorting: true,
      cell: ({ row }) => <span className="font-mono text-sm text-text-secondary">#{row.original.prNumber}</span>,
    },
    {
      id: "name",
      accessorKey: "branchName",
      header: "Name",
      size: NAME_WIDTH,
      enableSorting: false,
      cell: ({ row }) => <PRNameCell title={row.original.prTitle} branchName={row.original.branchName} />,
    },
    {
      id: "author",
      header: "Author",
      size: AUTHOR_WIDTH,
      enableSorting: false,
      cell: ({ row }) => <PRAuthorCell authorLogin={row.original.prAuthorLogin} />,
    },
    // No State column: the tab IS the state filter, so within a tab every row carries the same one. It was a
    // badge repeated twenty-five times saying what the tab above it already said.
    {
      id: "activity",
      header: "Updated",
      size: ACTIVITY_WIDTH,
      enableSorting: false,
      cell: ({ row }) => <PRActivityCell row={row.original} />,
    },
    {
      id: "health",
      header: "Health",
      size: HEALTH_WIDTH,
      enableSorting: false,
      cell: ({ row }) => <PrStatusPill status={row.original.prStatus} empty="dash" />,
    },
  ];

  if (hasPreviews) {
    // Ahead of Updated, where it sat when it was unconditional - found by id rather than by a position that
    // silently moves the day a column is added above it.
    const beforeActivity = columns.findIndex((column) => column.id === "activity");
    columns.splice(beforeActivity, 0, {
      id: "preview",
      header: "Preview",
      size: PREVIEW_WIDTH,
      enableSorting: false,
      cell: ({ row }) => <PRPreviewCell previewUrl={row.original.previewUrl} liveness={liveness} />,
    });
  }

  return columns;
}
