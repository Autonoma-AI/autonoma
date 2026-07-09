import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn,
} from "@autonoma/blacklight";
import { connectionTargets } from "@autonoma/types";
import { AppWindowIcon } from "@phosphor-icons/react/AppWindow";
import { useState } from "react";
import { ServiceCard } from "../../../onboarding/-components/previewkit/service-card";
import {
  SERVICE_OPTIONS,
  serviceRecipeSupportsUrlToken,
  serviceRecipeUsesCustomImage,
  type ServiceDraft,
} from "../../../onboarding/-components/previewkit/topology-draft";
import { usePreviewDraft } from "./-draft-context";

type ServiceTab = "overview" | "settings";

function isServiceTab(value: unknown): value is ServiceTab {
  return value === "overview" || value === "settings";
}

/**
 * One managed service's pane (design "5b"): the overview makes the shared
 * nature explicit - which variables the service exposes (and when they
 * resolve) plus the apps currently binding them - while the settings tab holds
 * the editable instance config.
 */
export function ServiceView({ service }: { service: ServiceDraft }) {
  const { draft, deployableApps, removeService, setServices } = usePreviewDraft();
  const [tab, setTab] = useState<ServiceTab>("overview");

  function handleTabChange(value: unknown) {
    if (isServiceTab(value)) setTab(value);
  }

  const serviceName = service.name.trim();
  const exposes = exposedProperties(service);
  const usedBy = deployableApps.filter((app) =>
    app.env.some((row) => !row.sensitive && connectionTargets(row.value).includes(serviceName)),
  );

  return (
    <Tabs value={tab} onValueChange={handleTabChange} className="gap-0">
      <header className="flex items-center border-b border-border-dim px-4 py-3 lg:px-6">
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
      </header>

      <TabsContent value="overview" className="flex max-w-2xl flex-col gap-6 p-4 lg:p-6">
        <Alert variant="info">
          <AlertTitle>Shared service</AlertTitle>
          <AlertDescription>
            Provisioned once at build. The variables below resolve when the build runs and can be bound into any app.
          </AlertDescription>
        </Alert>

        <div>
          <p className="mb-2.5 font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">
            Exposes {exposes.length} variables
          </p>
          <div className="border border-border-dim">
            {exposes.map((exposed, index) => (
              <div
                key={exposed.property}
                className={cn(
                  "flex items-center justify-between gap-3 px-3.5 py-2.5",
                  index < exposes.length - 1 && "border-b border-border-dim",
                  exposed.resolvesAt === "build" && "bg-status-pending/5",
                )}
              >
                <span
                  className={cn(
                    "truncate font-mono text-xs",
                    exposed.resolvesAt === "build" ? "text-status-pending" : "text-text-secondary",
                  )}
                >
                  {exposed.property}
                  {exposed.knownValue != null ? ` · ${exposed.knownValue}` : ""}
                </span>
                {exposed.resolvesAt === "build" ? (
                  <span className="shrink-0 border border-status-pending/30 bg-status-pending/10 px-1.5 py-px font-mono text-4xs font-bold uppercase tracking-wider text-status-pending">
                    At build
                  </span>
                ) : (
                  <span className="shrink-0 border border-border-mid bg-surface-raised px-1.5 py-px font-mono text-4xs font-semibold uppercase tracking-wider text-text-secondary">
                    Known
                  </span>
                )}
              </div>
            ))}
          </div>
          <p className="mt-2 text-2xs text-text-secondary">
            Bind one into an app from its Variables tab - set the variable's source to{" "}
            <span className="font-mono text-text-primary">from service</span>.
          </p>
        </div>

        <div>
          <p className="mb-2.5 font-mono text-4xs font-semibold uppercase tracking-widest text-text-secondary">
            Used by {usedBy.length} {usedBy.length === 1 ? "app" : "apps"}
          </p>
          {usedBy.length === 0 ? (
            <p className="text-sm text-text-secondary">No app binds this service's variables yet.</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {usedBy.map((app) => (
                  <Badge key={app.id} variant="outline" className="gap-1.5 font-mono">
                    <AppWindowIcon size={13} />
                    {app.name}
                  </Badge>
                ))}
              </div>
              <p className="mt-2.5 font-mono text-3xs text-text-secondary">
                Detaching removes these bindings from {usedBy.length === 1 ? "that app" : `all ${usedBy.length} apps`}.
              </p>
            </>
          )}
        </div>
      </TabsContent>

      <TabsContent value="settings" className="max-w-2xl p-4 lg:p-6">
        <ServiceCard
          service={service}
          onUpdate={(patch) =>
            setServices(
              draft.services.map((candidate) => (candidate.id === service.id ? { ...candidate, ...patch } : candidate)),
            )
          }
          onRemove={() => removeService(service.id)}
        />
      </TabsContent>
    </Tabs>
  );
}

interface ExposedProperty {
  property: string;
  resolvesAt: "build" | "known";
  /** Only for known properties: the value the reference resolves to (a recipe's fixed port). */
  knownValue?: string;
}

/**
 * The `{{name.property}}` references this service exposes, tagged by when their
 * value exists: `url`/`host` are provisioned during the build, while `port` is a
 * fixed recipe constant (or the custom image's configured port) and so is known
 * already. Mirrors the properties offered by the variable drawer's bind targets.
 */
function exposedProperties(service: ServiceDraft): ExposedProperty[] {
  const option = SERVICE_OPTIONS.find((candidate) => candidate.recipe === service.recipe);
  const customPort = serviceRecipeUsesCustomImage(service.recipe) ? service.port.trim() : "";
  const knownPort = customPort !== "" ? customPort : option?.defaultPort != null ? String(option.defaultPort) : "";

  const rows: ExposedProperty[] = [];
  if (serviceRecipeSupportsUrlToken(service.recipe)) rows.push({ property: "url", resolvesAt: "build" });
  rows.push({ property: "host", resolvesAt: "build" });
  if (knownPort !== "") {
    rows.push({ property: "port", resolvesAt: "known", knownValue: knownPort });
  } else {
    rows.push({ property: "port", resolvesAt: "build" });
  }
  return rows;
}
