import { cn } from "@autonoma/blacklight";
import { LockIcon } from "@phosphor-icons/react/Lock";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import type { ReactNode } from "react";
import type { VariableView } from "./variable-model";

interface VariableListProps {
  /** Variables surviving the search filter, in list order. */
  visible: VariableView[];
  selectedRowId?: number;
  searching: boolean;
  onSelect: (rowId: number) => void;
}

/**
 * The scannable key list on the left of the variable manager, split into
 * Connections (topology-wired, resolved at deploy) and Secrets (AWS).
 */
export function VariableList({ visible, selectedRowId, searching, onSelect }: VariableListProps) {
  const connections = visible.filter((variable) => variable.isConnection);
  const secrets = visible.filter((variable) => !variable.isConnection);

  return (
    <div className="flex min-w-0 flex-col border-b border-border-dim sm:border-b-0 sm:border-r">
      {visible.length === 0 ? (
        <p className="px-3.5 py-4 font-mono text-2xs text-text-secondary">
          {searching ? "No variables match." : "No variables yet."}
        </p>
      ) : (
        <div className="overflow-y-auto">
          <Section title="Connections" count={connections.length}>
            {connections.map((variable) => (
              <VariableRow
                key={variable.row.id}
                variable={variable}
                selected={variable.row.id === selectedRowId}
                onSelect={onSelect}
              />
            ))}
          </Section>
          <Section title="Secrets" count={secrets.length}>
            {secrets.map((variable) => (
              <VariableRow
                key={variable.row.id}
                variable={variable}
                selected={variable.row.id === selectedRowId}
                onSelect={onSelect}
              />
            ))}
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return undefined;
  return (
    <div>
      <p className="flex items-center justify-between border-b border-border-dim bg-surface-base/40 px-3.5 py-2 font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">
        <span>{title}</span>
        <span>{count}</span>
      </p>
      {children}
    </div>
  );
}

function VariableRow({
  variable,
  selected,
  onSelect,
}: {
  variable: VariableView;
  selected: boolean;
  onSelect: (rowId: number) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(variable.row.id)}
      className={cn(
        "flex w-full items-center justify-between gap-2 border-b border-border-dim/60 border-l-2 px-3 py-2.5 text-left transition-colors",
        selected ? "border-l-primary bg-surface-base" : "border-l-transparent hover:bg-surface-base/60",
      )}
    >
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 font-mono text-xs",
          selected ? "font-medium text-text-primary" : "text-text-secondary",
        )}
      >
        {variable.isConnection ? (
          <PlugsConnectedIcon size={12} className="shrink-0 text-status-pending" />
        ) : (
          <LockIcon size={11} className="shrink-0 text-text-secondary" />
        )}
        <span className="truncate">{variable.key === "" ? "unnamed" : variable.key}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">
        {variable.isConnection && variable.references.length > 0 ? (
          <span
            className={cn(
              "max-w-28 truncate font-mono text-4xs",
              variable.unknownReferences.length > 0 ? "text-status-critical" : "text-text-secondary",
            )}
            title={
              variable.unknownReferences.length > 0
                ? `Unknown reference: ${variable.unknownReferences.join(", ")} - not a service or app in this preview`
                : variable.references.join(", ")
            }
          >
            → {variable.references.join(", ")}
          </span>
        ) : undefined}
        {variable.buildTime ? (
          <span
            title="Also injected as a build argument during the image build"
            className="border border-primary/35 bg-primary/10 px-1 py-px font-mono text-4xs font-bold uppercase tracking-wider text-primary-ink"
          >
            Build
          </span>
        ) : undefined}
      </span>
    </button>
  );
}
