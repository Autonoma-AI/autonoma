import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@autonoma/blacklight";
import { useState } from "react";
import { AppCard } from "../../../onboarding/-components/previewkit/app-card";
import type { AppDraft } from "../../../onboarding/-components/previewkit/topology-draft";
import { AppHooks } from "./-app-hooks";
import { usePreviewDraft } from "./-draft-context";
import { EnvVarManager } from "./-variables/env-var-manager";

type AppTab = "overview" | "variables" | "hooks";

function isAppTab(value: unknown): value is AppTab {
  return value === "overview" || value === "variables" || value === "hooks";
}

/**
 * One app's pane (design "5a"): line tabs for the build/runtime wiring
 * (Overview), the unified variable manager (Variables, design "3a"), and the
 * app's slice of the deploy hooks (Hooks).
 */
export function AppView({ app }: { app: AppDraft }) {
  const { draft, deployableApps, issues, repoGroups, allNames, updateApp, setPrimaryApp, removeApp } =
    usePreviewDraft();
  // Variables is the hero tab of the redesign; the wiring lives one tab over.
  const [tab, setTab] = useState<AppTab>("variables");

  const appName = app.name.trim();
  const hookCount = [...draft.hooks.pre_deploy, ...draft.hooks.post_deploy].filter(
    (step) => appName !== "" && step.app.trim() === appName,
  ).length;

  function handleTabChange(value: unknown) {
    if (isAppTab(value)) setTab(value);
  }

  return (
    <Tabs value={tab} onValueChange={handleTabChange} className="gap-0">
      <header className="flex items-center border-b border-border-dim px-4 py-3 lg:px-6">
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="variables">Variables · {app.env.length}</TabsTrigger>
          <TabsTrigger value="hooks">Hooks · {hookCount}</TabsTrigger>
        </TabsList>
      </header>

      <TabsContent value="overview" className="flex flex-col gap-5 p-4 lg:p-6">
        {draft.repos.length > 0 ? (
          <div className="max-w-xs">
            <p className="mb-1.5 font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">
              Repository
            </p>
            <Select<string>
              value={app.repoKey}
              onValueChange={(repoKey) => {
                if (repoKey != null) updateApp(app.id, { repoKey });
              }}
            >
              <SelectTrigger aria-label="App repository">
                <span className="truncate">
                  {repoGroups.find((group) => group.key === app.repoKey)?.label ?? app.repoKey}
                </span>
              </SelectTrigger>
              <SelectContent>
                {repoGroups.map((group) => (
                  <SelectItem key={group.key} value={group.key}>
                    <span className="flex items-baseline gap-2">
                      {group.label}
                      <span className="text-4xs uppercase tracking-wider text-text-secondary">{group.badge}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : undefined}
        <AppCard
          app={app}
          issues={issues}
          dependencyOptions={allNames.filter((name) => name.trim() !== "" && name !== app.name)}
          defaultExpanded
          onChange={updateApp}
          onSetPrimary={setPrimaryApp}
          onRemove={removeApp}
        />
      </TabsContent>

      <TabsContent value="variables" className="p-4 lg:p-6">
        <EnvVarManager
          app={app}
          services={draft.services}
          deployableApps={deployableApps}
          issues={issues}
          updateApp={updateApp}
        />
      </TabsContent>

      <TabsContent value="hooks" className="p-4 lg:p-6">
        <AppHooks app={app} />
      </TabsContent>
    </Tabs>
  );
}
