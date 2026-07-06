import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@autonoma/blacklight";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { AppEnvEditor } from "./app-env-editor";
import {
  SERVICE_OPTIONS,
  serviceDraftForRecipe,
  serviceRecipeUsesCustomImage,
  type EnvRowDraft,
  type ServiceDraft,
  type ServiceReadinessDraft,
  type ServiceReadinessKind,
  type ServiceRecipe,
} from "./topology-draft";

interface ServicesSectionProps {
  services: ServiceDraft[];
  showEnv?: boolean;
  onChange: (services: ServiceDraft[]) => void;
}

/**
 * Managed services come from the recipe catalog (not from repos), so they are a
 * separate section from deployable apps: no entrypoints, just recipe + version.
 *
 * The catalog backend allows any number of services per recipe (constrained only
 * by unique names), so the picker is an "add" palette plus a flat list of
 * configured instances - each independently editable and removable - rather than
 * a one-toggle-per-recipe grid.
 */
export function ServicesSection({ services, showEnv = true, onChange }: ServicesSectionProps) {
  function addService(recipe: ServiceRecipe) {
    onChange([
      ...services,
      serviceDraftForRecipe(
        recipe,
        services.map((service) => service.name),
      ),
    ]);
  }

  function removeService(id: number) {
    onChange(services.filter((service) => service.id !== id));
  }

  function updateService(id: number, patch: Partial<ServiceDraft>) {
    onChange(services.map((service) => (service.id === id ? { ...service, ...patch } : service)));
  }

  return (
    <section className="border border-border-dim bg-surface-base">
      <div className="flex items-center justify-between border-b border-border-dim bg-surface-raised px-5 py-4">
        <h3 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">Managed services</h3>
        <span className="font-mono text-2xs text-text-secondary">from the recipe catalog</span>
      </div>
      <div className="flex flex-wrap gap-2 border-b border-border-dim p-4">
        {SERVICE_OPTIONS.map((option) => (
          <Button
            key={option.recipe}
            type="button"
            variant="outline"
            size="xs"
            onClick={() => addService(option.recipe)}
          >
            <PlusIcon size={12} weight="bold" />
            {option.label}
          </Button>
        ))}
      </div>
      <div className="grid gap-3 p-5">
        {services.length === 0 ? (
          <p className="text-sm text-text-secondary">No managed services yet. Add one from the catalog above.</p>
        ) : (
          services.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              showEnv={showEnv}
              onUpdate={(patch) => updateService(service.id, patch)}
              onRemove={() => removeService(service.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}

interface ServiceCardProps {
  service: ServiceDraft;
  showEnv: boolean;
  onUpdate: (patch: Partial<ServiceDraft>) => void;
  onRemove: () => void;
}

function ServiceCard({ service, showEnv, onUpdate, onRemove }: ServiceCardProps) {
  const option = SERVICE_OPTIONS.find((candidate) => candidate.recipe === service.recipe);
  const label = option?.label ?? service.recipe;
  const customImage = serviceRecipeUsesCustomImage(service.recipe);
  return (
    <div className="border border-border-dim">
      <div className="flex items-center gap-3 border-b border-border-dim bg-surface-raised px-4 py-3">
        <DatabaseIcon size={18} className="text-text-secondary" />
        <span className="font-medium text-text-primary">{label}</span>
        <span className="font-mono text-2xs text-text-secondary">{option?.meta ?? service.recipe}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          title="Remove service"
          aria-label={`Remove ${service.name.trim() === "" ? label : service.name}`}
          onClick={onRemove}
        >
          <TrashIcon size={14} />
        </Button>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        <div>
          <Label htmlFor={`pk-service-${service.id}-name`}>Name</Label>
          <Input
            id={`pk-service-${service.id}-name`}
            value={service.name}
            onChange={(event) => onUpdate({ name: event.target.value })}
            placeholder={option?.defaultName ?? service.recipe}
            className="font-mono"
          />
        </div>
        {customImage ? (
          <>
            <div>
              <Label htmlFor={`pk-service-${service.id}-image`}>Image</Label>
              <Input
                id={`pk-service-${service.id}-image`}
                value={service.image}
                onChange={(event) => onUpdate({ image: event.target.value })}
                placeholder="ghcr.io/org/image:tag"
                className="font-mono"
              />
            </div>
            <div>
              <Label htmlFor={`pk-service-${service.id}-port`}>Port</Label>
              <Input
                id={`pk-service-${service.id}-port`}
                value={service.port}
                onChange={(event) => onUpdate({ port: event.target.value })}
                placeholder="8080"
                inputMode="numeric"
                className="font-mono"
              />
            </div>
          </>
        ) : (
          <div>
            <Label htmlFor={`pk-service-${service.id}-version`}>Version</Label>
            <Input
              id={`pk-service-${service.id}-version`}
              value={service.version}
              onChange={(event) => onUpdate({ version: event.target.value })}
              placeholder={option?.version ?? "latest"}
              className="font-mono"
            />
          </div>
        )}
        {showEnv || customImage ? (
          <details className="sm:col-span-2">
            <summary className="cursor-pointer font-mono text-2xs uppercase tracking-widest text-text-secondary">
              Advanced service config
            </summary>
            {showEnv ? (
              <div className="mt-4">
                <AppEnvEditor
                  appDraftId={service.id}
                  rows={service.env}
                  referenceTokens={[]}
                  title="Service env"
                  addLabel="Add env"
                  emptyLabel="No service environment variables."
                  onChange={(env: EnvRowDraft[]) => onUpdate({ env })}
                />
              </div>
            ) : undefined}
            {customImage ? <CustomImageAdvanced service={service} onUpdate={onUpdate} /> : undefined}
          </details>
        ) : undefined}
      </div>
    </div>
  );
}

const READINESS_OPTIONS: { value: ServiceReadinessKind; label: string }[] = [
  { value: "none", label: "None" },
  { value: "http", label: "HTTP" },
  { value: "exec", label: "Exec" },
  { value: "tcp", label: "TCP" },
];

/**
 * Custom-image (docker-image) extras that don't fit the main grid: optional port
 * name, extra ports, command/args overrides, and a readiness probe. Renders only
 * for docker-image services, inside the Advanced service config section.
 */
function CustomImageAdvanced({
  service,
  onUpdate,
}: {
  service: ServiceDraft;
  onUpdate: (patch: Partial<ServiceDraft>) => void;
}) {
  const readiness = service.readiness;
  function updateReadiness(patch: Partial<ServiceReadinessDraft>) {
    onUpdate({ readiness: { ...readiness, ...patch } });
  }

  const portFieldVisible = readiness.kind === "http" || readiness.kind === "tcp";

  return (
    <div className="mt-6 space-y-4 border-t border-border-dim pt-4">
      <div>
        <Label htmlFor={`pk-service-${service.id}-portName`}>Primary port name</Label>
        <Input
          id={`pk-service-${service.id}-portName`}
          value={service.portName}
          onChange={(event) => onUpdate({ portName: event.target.value })}
          placeholder="primary"
          className="font-mono"
        />
      </div>

      <div>
        <Label htmlFor={`pk-service-${service.id}-additionalPorts`}>Additional ports</Label>
        <Textarea
          id={`pk-service-${service.id}-additionalPorts`}
          value={service.additionalPorts}
          onChange={(event) => onUpdate({ additionalPorts: event.target.value })}
          placeholder={"metrics:9090\n8025"}
          rows={2}
          className="font-mono [field-sizing:content]"
        />
        <p className="mt-1 text-2xs text-text-secondary">One per line, as `port` or `name:port`.</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor={`pk-service-${service.id}-command`}>Command</Label>
          <Textarea
            id={`pk-service-${service.id}-command`}
            value={service.command}
            onChange={(event) => onUpdate({ command: event.target.value })}
            placeholder={"server\n/data"}
            rows={2}
            className="font-mono [field-sizing:content]"
          />
          <p className="mt-1 text-2xs text-text-secondary">Overrides the image entrypoint. One token per line.</p>
        </div>
        <div>
          <Label htmlFor={`pk-service-${service.id}-args`}>Args</Label>
          <Textarea
            id={`pk-service-${service.id}-args`}
            value={service.args}
            onChange={(event) => onUpdate({ args: event.target.value })}
            placeholder={"--console-address\n:9001"}
            rows={2}
            className="font-mono [field-sizing:content]"
          />
          <p className="mt-1 text-2xs text-text-secondary">One token per line.</p>
        </div>
      </div>

      <div className="space-y-3 border border-border-dim p-3">
        <div>
          <Label htmlFor={`pk-service-${service.id}-readiness-kind`}>Readiness probe</Label>
          <Select<ServiceReadinessKind>
            value={readiness.kind}
            onValueChange={(value) => updateReadiness({ kind: value ?? "none" })}
          >
            <SelectTrigger id={`pk-service-${service.id}-readiness-kind`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {READINESS_OPTIONS.map((probe) => (
                <SelectItem key={probe.value} value={probe.value}>
                  {probe.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {readiness.kind === "http" ? (
          <div>
            <Label htmlFor={`pk-service-${service.id}-readiness-path`}>HTTP path</Label>
            <Input
              id={`pk-service-${service.id}-readiness-path`}
              value={readiness.httpPath}
              onChange={(event) => updateReadiness({ httpPath: event.target.value })}
              placeholder="/healthz"
              className="font-mono"
            />
          </div>
        ) : undefined}

        {readiness.kind === "exec" ? (
          <div>
            <Label htmlFor={`pk-service-${service.id}-readiness-exec`}>Exec command</Label>
            <Textarea
              id={`pk-service-${service.id}-readiness-exec`}
              value={readiness.execCommand}
              onChange={(event) => updateReadiness({ execCommand: event.target.value })}
              placeholder={"redis-cli\nping"}
              rows={2}
              className="font-mono [field-sizing:content]"
            />
            <p className="mt-1 text-2xs text-text-secondary">One token per line.</p>
          </div>
        ) : undefined}

        {portFieldVisible ? (
          <div>
            <Label htmlFor={`pk-service-${service.id}-readiness-port`}>Probe port</Label>
            <Input
              id={`pk-service-${service.id}-readiness-port`}
              value={readiness.port}
              onChange={(event) => updateReadiness({ port: event.target.value })}
              placeholder={service.port.trim() === "" ? "8080" : `${service.port} (primary)`}
              inputMode="numeric"
              className="font-mono"
            />
            <p className="mt-1 text-2xs text-text-secondary">Defaults to the primary port when blank.</p>
          </div>
        ) : undefined}

        {readiness.kind === "none" ? undefined : (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor={`pk-service-${service.id}-readiness-initial`}>Initial delay (s)</Label>
              <Input
                id={`pk-service-${service.id}-readiness-initial`}
                value={readiness.initialDelaySeconds}
                onChange={(event) => updateReadiness({ initialDelaySeconds: event.target.value })}
                placeholder="0"
                inputMode="numeric"
                className="font-mono"
              />
            </div>
            <div>
              <Label htmlFor={`pk-service-${service.id}-readiness-period`}>Period (s)</Label>
              <Input
                id={`pk-service-${service.id}-readiness-period`}
                value={readiness.periodSeconds}
                onChange={(event) => updateReadiness({ periodSeconds: event.target.value })}
                placeholder="10"
                inputMode="numeric"
                className="font-mono"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
