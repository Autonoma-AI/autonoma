import { Button, Input } from "@autonoma/blacklight";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { useState } from "react";
import {
  PRIMARY_REPO_KEY,
  envRow,
  envRowsFromDotenv,
  fieldIssueKey,
  type AppDraft,
  type DraftIssues,
  type ServiceDraft,
} from "../../../../onboarding/-components/previewkit/topology-draft";
import { InjectedBlock } from "./injected-block";
import { PasteEnvDialog } from "./paste-env-dialog";
import { VariableDrawer } from "./variable-drawer";
import { VariableList } from "./variable-list";
import {
  applyVariable,
  bindTargets,
  injectedVars,
  removeVariable,
  variableViews,
  type VariableForm,
} from "./variable-model";

interface EnvVarManagerProps {
  app: AppDraft;
  /** Managed services in the topology - the connection targets. */
  services: ServiceDraft[];
  /** Real (non-starter) apps - also connection targets ({{app.url}}). */
  deployableApps: AppDraft[];
  issues: DraftIssues;
  updateApp: (id: number, patch: Partial<AppDraft>) => void;
}

/**
 * Unified per-app variable manager: a list split into Connections + Secrets with
 * a focused editor drawer beside it. Every variable injects at runtime; build
 * time is an opt-in flag; connections wire to a service/app.
 */
export function EnvVarManager({ app, services, deployableApps, issues, updateApp }: EnvVarManagerProps) {
  const targets = bindTargets(services, deployableApps);
  const variables = variableViews(app, targets);
  const injected = injectedVars(app.primary);
  const secretsSupported = app.repoKey === PRIMARY_REPO_KEY;

  const [selected, setSelected] = useState<number | undefined>(undefined);
  const [search, setSearch] = useState("");

  // A stale or empty selection falls back to the first variable, so the drawer
  // always shows something once variables exist (including the async-merged
  // stored-secret rows).
  const selectedView = variables.find((v) => v.row.id === selected) ?? variables[0];

  const query = search.trim().toLowerCase();
  const visible = query === "" ? variables : variables.filter((v) => v.key.toLowerCase().includes(query));
  const envIssue =
    issues.fieldErrors.get(fieldIssueKey(app.id, "env"))?.[0] ??
    issues.fieldWarnings.get(fieldIssueKey(app.id, "env"))?.[0];

  const isBlank = (view: (typeof variables)[number] | undefined) =>
    view != null && view.key === "" && view.row.value === "";

  function handleChange(form: VariableForm) {
    if (selectedView == null) return;
    updateApp(app.id, applyVariable(app, selectedView.row.id, form).patch);
  }

  function selectVariable(rowId: number) {
    if (isBlank(selectedView) && selectedView != null && selectedView.row.id !== rowId) {
      updateApp(app.id, removeVariable(app, selectedView.row.id));
    }
    setSelected(rowId);
  }

  function addVariable() {
    const base =
      isBlank(selectedView) && selectedView != null ? app.env.filter((row) => row.id !== selectedView.row.id) : app.env;
    const blank = envRow("", "", true, "new", false);
    updateApp(app.id, { env: [...base, blank] });
    setSelected(blank.id);
  }

  function importDotenv(entries: Array<{ key: string; value: string }>) {
    if (entries.length === 0) return;
    updateApp(app.id, { env: envRowsFromDotenv(app.env, entries) });
  }

  function deleteVariable(rowId: number) {
    updateApp(app.id, removeVariable(app, rowId));
    if (selectedView?.row.id === rowId) setSelected(undefined);
  }

  function handleDelete() {
    if (selectedView == null) return;
    deleteVariable(selectedView.row.id);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex items-center gap-2 font-mono text-2xs font-bold uppercase tracking-wider text-text-secondary">
          <span className="size-1.5 bg-primary" />
          Environment variables
        </p>
        <span className="border border-border-mid px-1.5 py-0.5 font-mono text-3xs text-text-secondary">
          {variables.length}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <div className="relative">
            <MagnifyingGlassIcon
              size={12}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-secondary"
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search"
              aria-label="Search variables"
              className="h-8 w-36 pl-7 text-2xs sm:w-44"
            />
          </div>
          <PasteEnvDialog onImport={importDotenv} />
          <Button variant="cta" size="sm" className="gap-1" onClick={addVariable}>
            <PlusIcon size={12} weight="bold" />
            Add variable
          </Button>
        </div>
      </div>

      <InjectedBlock vars={injected} />

      {variables.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 border border-border-dim px-6 py-14 text-center">
          <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">No variables yet</p>
          <div className="flex items-center gap-2">
            <PasteEnvDialog onImport={importDotenv} />
            <Button variant="cta" size="sm" className="gap-1" onClick={addVariable}>
              <PlusIcon size={12} weight="bold" />
              Add variable
            </Button>
          </div>
        </div>
      ) : (
        <div className="grid border border-border-dim sm:grid-cols-[18rem_minmax(0,1fr)] sm:items-start">
          <VariableList
            visible={visible}
            selectedRowId={selectedView?.row.id}
            searching={query !== ""}
            onSelect={selectVariable}
            onDelete={deleteVariable}
          />
          <div className="sm:sticky sm:top-4 sm:max-h-[calc(100vh-2rem)] sm:self-start sm:overflow-y-auto">
            {selectedView != null ? (
              <VariableDrawer
                key={selectedView.row.id}
                app={app}
                view={selectedView}
                targets={targets}
                secretsSupported={secretsSupported}
                onChange={handleChange}
                onDelete={handleDelete}
              />
            ) : undefined}
          </div>
        </div>
      )}

      {envIssue != null ? <p className="text-2xs text-status-critical">{envIssue}</p> : undefined}
    </div>
  );
}
