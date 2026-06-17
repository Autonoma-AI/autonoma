import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
} from "@autonoma/blacklight";
import { BracketsCurlyIcon } from "@phosphor-icons/react/BracketsCurly";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { nextDraftId, type EnvRowDraft } from "./topology-draft";

interface AppEnvEditorProps {
  appDraftId: number;
  rows: EnvRowDraft[];
  /** `{{name.field}}` tokens offered by the insert-reference menu (built from services + other apps). */
  referenceTokens: string[];
  title?: string;
  addLabel?: string;
  emptyLabel?: string;
  error?: string;
  warning?: string;
  onChange: (rows: EnvRowDraft[]) => void;
}

/**
 * Non-secret environment variables for one app. Values support
 * `{{service.url}}`-style template references resolved by PreviewKit at deploy
 * time; secrets stay in the dedicated write-only secrets section.
 */
export function AppEnvEditor({
  appDraftId,
  rows,
  referenceTokens,
  title = "Environment variables",
  addLabel = "Add variable",
  emptyLabel = "No environment variables. Secrets live in the secrets section below.",
  error,
  warning,
  onChange,
}: AppEnvEditorProps) {
  function updateRow(id: number, patch: Partial<EnvRowDraft>) {
    onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: number) {
    onChange(rows.filter((row) => row.id !== id));
  }

  function addRow() {
    onChange([...rows, { id: nextDraftId(), key: "", value: "" }]);
  }

  function appendReference(id: number, token: string) {
    const row = rows.find((candidate) => candidate.id === id);
    if (row == null) return;
    updateRow(id, { value: `${row.value}${token}` });
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">{title}</p>
        <Button variant="ghost" size="xs" className="gap-1" onClick={addRow}>
          <PlusIcon size={12} weight="bold" />
          {addLabel}
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">{emptyLabel}</p>
      ) : (
        <div className="mt-2 space-y-2">
          {rows.map((row) => (
            <div key={row.id} className="grid grid-cols-[minmax(8rem,0.6fr)_minmax(10rem,1fr)_auto_auto] gap-2">
              <Input
                id={`pk-app-${appDraftId}-env-${row.id}-key`}
                value={row.key}
                onChange={(event) => updateRow(row.id, { key: event.target.value })}
                placeholder="API_URL"
                className="font-mono"
              />
              <Input
                value={row.value}
                onChange={(event) => updateRow(row.id, { value: event.target.value })}
                placeholder="http://{{api.host}}:{{api.port}}"
                className="font-mono"
              />
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="Insert reference"
                      disabled={referenceTokens.length === 0}
                    >
                      <BracketsCurlyIcon size={14} />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  {referenceTokens.map((token) => (
                    <DropdownMenuItem key={token} onClick={() => appendReference(row.id, token)}>
                      <span className="font-mono text-2xs">{token}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <Button variant="ghost" size="icon-sm" title="Remove variable" onClick={() => removeRow(row.id)}>
                <TrashIcon size={14} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {error != null ? <p className="mt-2 text-2xs text-status-critical">{error}</p> : undefined}
      {warning != null ? <p className="mt-2 text-2xs text-status-warn">{warning}</p> : undefined}
    </div>
  );
}
