import {
  Badge,
  Button,
  Dialog,
  DialogBackdrop,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  Switch,
  Textarea,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  cn,
} from "@autonoma/blacklight";
import { AUTONOMA_MANAGED_ENV_VARS, PREVIEWKIT_BUILTIN_ENV_VARS, detectSensitive } from "@autonoma/types";
import { BracketsCurlyIcon } from "@phosphor-icons/react/BracketsCurly";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { LockIcon } from "@phosphor-icons/react/Lock";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { XIcon } from "@phosphor-icons/react/X";
import { type FocusEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { envRow, sortEnvRows, type EnvRowDraft } from "./topology-draft";

type EnvFilter = "all" | "secrets" | "envs";

// Run secret detection only after the user pauses typing, not on every keystroke
// (mirrors a search box debounce). Avoids the toggle/mask flickering mid-type.
const DETECT_DEBOUNCE_MS = 300;

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
  /** Show the read-only Previewkit built-in env vars above the editable rows. Only for the app env section. */
  showBuiltins?: boolean;
  /**
   * Also list the Autonoma-managed SDK secrets (AUTONOMA_SHARED_SECRET /
   * AUTONOMA_SIGNING_SECRET) in the injected card. Only the primary (SDK) app
   * receives them, so callers pass this for that app alone.
   */
  showManagedSecrets?: boolean;
  /**
   * Enable secret handling: a per-row "sensitive" toggle (auto-suggested via the
   * shared classifier after a debounce, user-overridable), masked existing-secret
   * rows, a secrets/envs filter, and an inline add-row. Only the app env section
   * sets this - build args / services stay plain.
   */
  enableSecrets?: boolean;
  onChange: (rows: EnvRowDraft[]) => void;
}

/**
 * Environment variables for one app. Values support `{{service.url}}`-style
 * template references resolved by PreviewKit at deploy time. When
 * `enableSecrets` is set, rows can be flagged sensitive (stored as secrets in
 * AWS rather than plaintext config), with the flag auto-suggested by the
 * `detectSensitive` classifier.
 */
export function AppEnvEditor({
  appDraftId,
  rows,
  referenceTokens,
  title = "Environment variables",
  addLabel = "Add variable",
  emptyLabel = "No environment variables.",
  error,
  warning,
  showBuiltins = false,
  showManagedSecrets = false,
  enableSecrets = false,
  onChange,
}: AppEnvEditorProps) {
  // Latest rows for use inside debounced timers / blur handlers (avoids stale closures).
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // Rows whose sensitivity the user set by hand; auto-detection stops driving them.
  const manualSensitivity = useRef<Set<number>>(new Set());
  // Per-row debounce timers for detection.
  const detectTimers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const [filter, setFilter] = useState<EnvFilter>("all");
  // Existing secret being converted to a plain variable: its value can't be read
  // back from AWS, so the user must re-enter it before we drop the secret.
  const [convertRow, setConvertRow] = useState<{ id: number; key: string }>();
  const [convertValue, setConvertValue] = useState("");

  // Committed rows render as text; clicking one (enableSecrets only) swaps it to
  // inputs so the add-row's permanent inputs stand out as "the place to add".
  const [editing, setEditing] = useState<{ id: number; field: "key" | "value" }>();
  const editKeyRef = useRef<HTMLInputElement>(null);
  const editValueRef = useRef<HTMLTextAreaElement>(null);
  // Ref menu opens a portal; suppress the row's blur-to-exit while it's open.
  const refMenuOpen = useRef(false);

  useEffect(() => {
    if (editing == null) return;
    if (editing.field === "key") editKeyRef.current?.focus();
    else editValueRef.current?.focus();
  }, [editing]);

  // Inline add-row state (only used when enableSecrets). The row being typed lives
  // here, NOT in the committed list, so it never sorts/jumps while you type. On
  // commit it joins the sorted list and the add-row resets to empty.
  const [addKey, setAddKey] = useState("");
  const [addValue, setAddValue] = useState("");
  const [addSensitive, setAddSensitive] = useState(false);
  const addManual = useRef(false);
  const addTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const addKeyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timers = detectTimers.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      if (addTimer.current != null) clearTimeout(addTimer.current);
    };
  }, []);

  function updateRow(id: number, patch: Partial<EnvRowDraft>) {
    onChange(rowsRef.current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  // Edit a key/value immediately (responsive), then debounce-detect sensitivity.
  function editKeyOrValue(id: number, patch: Partial<EnvRowDraft>) {
    updateRow(id, patch);
    if (!enableSecrets || manualSensitivity.current.has(id)) return;
    const existing = detectTimers.current.get(id);
    if (existing != null) clearTimeout(existing);
    detectTimers.current.set(
      id,
      setTimeout(() => {
        detectTimers.current.delete(id);
        const row = rowsRef.current.find((candidate) => candidate.id === id);
        if (row == null || row.origin === "secret" || manualSensitivity.current.has(id)) return;
        const sensitive = detectSensitive(row.key, row.value).sensitive;
        if (sensitive !== row.sensitive) updateRow(id, { sensitive });
      }, DETECT_DEBOUNCE_MS),
    );
  }

  function setSensitive(id: number, sensitive: boolean) {
    manualSensitivity.current.add(id);
    const pending = detectTimers.current.get(id);
    if (pending != null) {
      clearTimeout(pending);
      detectTimers.current.delete(id);
    }
    const row = rowsRef.current.find((candidate) => candidate.id === id);
    // Turning OFF an existing secret with no re-entered value: we can't recover
    // the value from AWS, so make the user supply it before dropping the secret.
    if (!sensitive && row != null && row.origin === "secret" && row.value.trim() === "") {
      setConvertValue("");
      setConvertRow({ id, key: row.key });
      return;
    }
    updateRow(id, { sensitive });
  }

  function confirmConvert() {
    if (convertRow == null || convertValue.trim() === "") return;
    manualSensitivity.current.add(convertRow.id);
    onChange(
      rowsRef.current.map((row) =>
        row.id === convertRow.id ? { ...row, sensitive: false, value: convertValue, origin: "config" } : row,
      ),
    );
    setConvertRow(undefined);
    setConvertValue("");
  }

  function removeRow(id: number) {
    onChange(rowsRef.current.filter((row) => row.id !== id));
  }

  function appendReference(id: number, token: string) {
    const row = rowsRef.current.find((candidate) => candidate.id === id);
    if (row == null) return;
    editKeyOrValue(id, { value: `${row.value}${token}` });
  }

  function handleEditRowBlur(event: FocusEvent<HTMLDivElement>) {
    // Stay in edit mode while focus moves within the row, or while the reference
    // dropdown (a portal) is open. Revert to text once focus truly leaves.
    if (refMenuOpen.current) return;
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setEditing(undefined);
  }

  function handleEditRowKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      setEditing(undefined);
    }
  }

  // In the value textarea Enter must insert a newline (multi-line secrets like
  // PEM keys), so only Escape exits edit mode there.
  function handleEditValueKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(undefined);
    }
  }

  // --- add-row (enableSecrets) ---
  function scheduleAddDetect(key: string, value: string) {
    if (addManual.current) return;
    if (addTimer.current != null) clearTimeout(addTimer.current);
    addTimer.current = setTimeout(() => setAddSensitive(detectSensitive(key, value).sensitive), DETECT_DEBOUNCE_MS);
  }

  function commitAddRow(refocus: boolean) {
    if (addKey.trim() === "") return;
    if (addTimer.current != null) clearTimeout(addTimer.current);
    const created = envRow(addKey.trim(), addValue, addSensitive, "new");
    onChange(sortEnvRows([...rowsRef.current, created]));
    setAddKey("");
    setAddValue("");
    setAddSensitive(false);
    addManual.current = false;
    if (refocus) addKeyRef.current?.focus();
  }

  function clearAddRow(refocus: boolean) {
    if (addTimer.current != null) clearTimeout(addTimer.current);
    setAddKey("");
    setAddValue("");
    setAddSensitive(false);
    addManual.current = false;
    if (refocus) addKeyRef.current?.focus();
  }

  function handleAddKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // Blur never commits - the user adds with the ✓ (Enter) or dismisses with ✗ (Esc).
    if (event.key === "Enter") {
      event.preventDefault();
      commitAddRow(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      clearAddRow(true);
    }
  }

  const hasAddDraft = addKey.trim() !== "" || addValue.trim() !== "";

  // --- legacy add (non-secret editors: build args / services) ---
  function addRowAppend() {
    onChange([...rowsRef.current, envRow("", "", false, "new")]);
  }

  const visibleRows = rows.filter((row) => {
    if (filter === "secrets") return row.sensitive;
    if (filter === "envs") return !row.sensitive;
    return true;
  });

  // Fixed-width action columns (icon-sm = size-7 = 1.75rem) so the toggle and
  // buttons line up across text rows, the add-row, and the edit row regardless of
  // whether a cell is a button or an empty placeholder.
  const gridCols = enableSecrets
    ? "grid-cols-[minmax(8rem,0.6fr)_minmax(10rem,1fr)_auto_1.75rem_1.75rem]"
    : "grid-cols-[minmax(8rem,0.6fr)_minmax(10rem,1fr)_1.75rem_1.75rem]";

  function renderRow(row: EnvRowDraft) {
    // Plain editors keep inputs always; secret-aware committed rows show as text
    // until clicked, so the permanent-input add-row reads as the add affordance.
    if (enableSecrets && editing?.id !== row.id) return renderDisplayRow(row);
    return renderEditRow(row);
  }

  function renderDisplayRow(row: EnvRowDraft) {
    const isExistingSecret = row.origin === "secret";
    const displayValue = row.sensitive
      ? isExistingSecret && row.value.trim() === ""
        ? "•••••• (set)"
        : "••••••"
      : row.value;
    return (
      <div key={row.id} className={`group grid ${gridCols} items-center gap-2`}>
        <button
          type="button"
          onClick={() => setEditing({ id: row.id, field: "key" })}
          className="truncate rounded px-2 py-1.5 text-left font-mono text-sm text-text-primary hover:bg-surface-raised"
          title="Click to edit"
        >
          {row.key.trim() === "" ? <span className="text-text-secondary">unnamed</span> : row.key}
        </button>
        <button
          type="button"
          onClick={() => setEditing({ id: row.id, field: "value" })}
          className="truncate rounded px-2 py-1.5 text-left font-mono text-xs text-text-secondary hover:bg-surface-raised"
          title="Click to edit"
        >
          {displayValue.trim() === "" ? <span className="text-text-secondary/60">empty</span> : displayValue}
        </button>
        <SensitivityToggle sensitive={row.sensitive} onChange={(on) => setSensitive(row.id, on)} />
        <span />
        <Button
          variant="ghost"
          size="icon-sm"
          title="Remove variable"
          className="opacity-0 transition-opacity group-hover:opacity-100"
          onClick={() => removeRow(row.id)}
        >
          <TrashIcon size={14} />
        </Button>
      </div>
    );
  }

  function renderEditRow(row: EnvRowDraft) {
    const isExistingSecret = row.origin === "secret";
    const valuePlaceholder = isExistingSecret ? "•••••• (set) - type to replace" : "http://{{api.host}}:{{api.port}}";
    return (
      <div
        key={row.id}
        className={`grid ${gridCols} items-center gap-2`}
        onBlur={enableSecrets ? handleEditRowBlur : undefined}
      >
        <Input
          ref={editing?.id === row.id && editing.field === "key" ? editKeyRef : undefined}
          id={`pk-app-${appDraftId}-env-${row.id}-key`}
          value={row.key}
          onChange={(event) => editKeyOrValue(row.id, { key: event.target.value })}
          onKeyDown={enableSecrets ? handleEditRowKeyDown : undefined}
          placeholder="API_URL"
          className="font-mono"
        />
        <Textarea
          ref={editing?.id === row.id && editing.field === "value" ? editValueRef : undefined}
          value={row.value}
          onChange={(event) => editKeyOrValue(row.id, { value: event.target.value })}
          onKeyDown={enableSecrets ? handleEditValueKeyDown : undefined}
          placeholder={valuePlaceholder}
          rows={1}
          // A textarea preserves pasted newlines (PEM keys, certs); auto-grows where
          // supported, manually resizable otherwise.
          className="min-h-0 resize-y py-1.5 font-mono [field-sizing:content]"
        />
        {enableSecrets ? (
          <SensitivityToggle sensitive={row.sensitive} onChange={(on) => setSensitive(row.id, on)} />
        ) : undefined}
        <ReferenceMenu
          tokens={referenceTokens}
          onOpenChange={(open) => (refMenuOpen.current = open)}
          onPick={(token) => appendReference(row.id, token)}
        />
        <Button variant="ghost" size="icon-sm" title="Remove variable" onClick={() => removeRow(row.id)}>
          <TrashIcon size={14} />
        </Button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">{title}</p>
        {enableSecrets ? undefined : (
          <Button variant="ghost" size="xs" className="gap-1" onClick={addRowAppend}>
            <PlusIcon size={12} weight="bold" />
            {addLabel}
          </Button>
        )}
      </div>
      {showBuiltins ? <BuiltInCard showManagedSecrets={showManagedSecrets} /> : undefined}

      {enableSecrets ? (
        <div className="mt-3 space-y-2">
          {/* Filter sits with the editable variables (below the built-ins card), not
              in the header, so it clearly governs the rows beneath it. */}
          {rows.length > 0 ? (
            <div className="flex justify-end">
              <EnvFilterControl filter={filter} onChange={setFilter} />
            </div>
          ) : undefined}
          {/* Always-present empty row to add the next variable. Blur does nothing;
              the user confirms with ✓ / Enter or dismisses with ✗ / Esc. The
              trailing cells (toggle, ✓, ✗) mirror committed rows' single-button
              columns so the key/value inputs line up exactly. */}
          <div className={`grid ${gridCols} items-center gap-2`}>
            <Input
              ref={addKeyRef}
              id={`pk-app-${appDraftId}-env-new-key`}
              value={addKey}
              onChange={(event) => {
                setAddKey(event.target.value);
                scheduleAddDetect(event.target.value, addValue);
              }}
              onKeyDown={handleAddKeyDown}
              placeholder="Add variable - KEY"
              className="font-mono"
            />
            <Textarea
              value={addValue}
              onChange={(event) => {
                setAddValue(event.target.value);
                scheduleAddDetect(addKey, event.target.value);
              }}
              // Enter inserts a newline (paste multi-line secrets); Esc clears the row.
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  clearAddRow(true);
                }
              }}
              placeholder="value or {{service.url}}"
              rows={1}
              className="min-h-0 resize-y py-1.5 font-mono [field-sizing:content]"
            />
            <SensitivityToggle
              sensitive={addSensitive}
              onChange={(on) => {
                addManual.current = true;
                setAddSensitive(on);
              }}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              title="Add variable"
              disabled={addKey.trim() === ""}
              onClick={() => commitAddRow(true)}
            >
              <CheckIcon size={14} weight="bold" className="text-status-success" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Dismiss"
              disabled={!hasAddDraft}
              onClick={() => clearAddRow(true)}
            >
              <XIcon size={14} />
            </Button>
          </div>
          {visibleRows.map(renderRow)}
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-text-secondary">{emptyLabel}</p>
      ) : (
        <div className="mt-2 space-y-2">{rows.map(renderRow)}</div>
      )}

      {error != null ? <p className="mt-2 text-2xs text-status-critical">{error}</p> : undefined}
      {warning != null ? <p className="mt-2 text-2xs text-status-warn">{warning}</p> : undefined}

      <Dialog open={convertRow != null} onOpenChange={(open) => (open ? undefined : setConvertRow(undefined))}>
        <DialogBackdrop />
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Convert secret to a plain variable</DialogTitle>
            <DialogDescription>
              <code>{convertRow?.key}</code> is stored as a secret, and its value can't be read back. Enter the value to
              keep it as a plaintext config variable - the secret will be removed on save.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Label htmlFor="pk-convert-secret-value">Value</Label>
            <Input
              id="pk-convert-secret-value"
              value={convertValue}
              onChange={(event) => setConvertValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") confirmConvert();
              }}
              placeholder="plaintext value"
              className="mt-1 font-mono"
            />
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConvertRow(undefined)}>
              Cancel
            </Button>
            <Button variant="accent" onClick={confirmConvert} disabled={convertValue.trim() === ""}>
              Make plain variable
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** The lock + switch that flags a row sensitive, with an explanatory tooltip. */
function SensitivityToggle({ sensitive, onChange }: { sensitive: boolean; onChange: (sensitive: boolean) => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex items-center gap-1.5 px-1">
            <LockIcon
              size={13}
              weight={sensitive ? "fill" : "regular"}
              className={sensitive ? "text-primary-ink" : "text-text-secondary"}
            />
            <Switch size="sm" checked={sensitive} onCheckedChange={onChange} aria-label="Store as secret" />
          </span>
        }
      >
        <TooltipContent className="max-w-xs">
          <p className="font-medium">{sensitive ? "Sensitive (secret)" : "Plain variable"}</p>
          <p className="mt-1 text-text-secondary">
            Turn ON for credentials - API keys, passwords, tokens, connection strings. Stored encrypted in the secret
            store, never shown again, and kept out of your config.
          </p>
          <p className="mt-1 text-text-secondary">
            Leave OFF for non-secret values - URLs, ports, feature flags, <code>{"{{service.url}}"}</code> templates.
            Saved in plaintext config and visible here.
          </p>
        </TooltipContent>
      </TooltipTrigger>
    </Tooltip>
  );
}

/** Dropdown to insert a `{{service.url}}` reference token into a value. */
function ReferenceMenu({
  tokens,
  onPick,
  onOpenChange,
}: {
  tokens: string[];
  onPick: (token: string) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon-sm" title="Insert reference" disabled={tokens.length === 0}>
            <BracketsCurlyIcon size={14} />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {tokens.map((token) => (
          <DropdownMenuItem key={token} onClick={() => onPick(token)}>
            <span className="font-mono text-2xs">{token}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const FILTER_OPTIONS: { value: EnvFilter; label: string }[] = [
  { value: "all", label: "Both" },
  { value: "secrets", label: "Secrets" },
  { value: "envs", label: "Envs" },
];

/** Segmented control to show only secrets, only plain vars, or both. */
function EnvFilterControl({ filter, onChange }: { filter: EnvFilter; onChange: (filter: EnvFilter) => void }) {
  return (
    <div className="inline-flex items-center gap-0.5 rounded border border-border-dim bg-surface-base p-0.5">
      {FILTER_OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={cn(
            "rounded px-2 py-0.5 font-mono text-2xs uppercase tracking-widest transition-colors",
            filter === option.value
              ? "bg-surface-raised text-text-primary"
              : "text-text-secondary hover:text-text-primary",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function BuiltInCard({ showManagedSecrets }: { showManagedSecrets: boolean }) {
  return (
    <div className="mt-2 rounded-md border border-border-dim bg-surface-base/40 p-3">
      <p className="mb-2 font-mono text-2xs uppercase tracking-widest text-text-secondary">Injected by Previewkit</p>
      <div className="space-y-1.5">
        {PREVIEWKIT_BUILTIN_ENV_VARS.map((variable) => (
          <InjectedEnvRow key={variable.key} variable={variable} badge="Built-in" />
        ))}
        {showManagedSecrets
          ? AUTONOMA_MANAGED_ENV_VARS.map((variable) => (
              <InjectedEnvRow key={variable.key} variable={variable} badge="Autonoma" />
            ))
          : undefined}
      </div>
      <p className="mt-2 text-2xs text-text-secondary">Injected automatically and reserved - you can't set these.</p>
    </div>
  );
}

function InjectedEnvRow({
  variable,
  badge,
}: {
  variable: { key: string; description: string; example: string };
  badge: string;
}) {
  return (
    <div className="grid grid-cols-[minmax(8rem,0.6fr)_minmax(10rem,1fr)_auto] items-center gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate font-mono text-sm text-text-primary">{variable.key}</span>
        <Badge variant="neutral" className="shrink-0">
          {badge}
        </Badge>
      </div>
      <div className="truncate rounded border border-border-dim bg-surface-void px-2 py-1 font-mono text-xs text-text-secondary">
        {variable.example}
      </div>
      <Tooltip>
        <TooltipTrigger render={<span className="cursor-help px-1 text-text-secondary" />}>
          <InfoIcon size={14} />
        </TooltipTrigger>
        <TooltipContent>{variable.description}</TooltipContent>
      </Tooltip>
    </div>
  );
}
