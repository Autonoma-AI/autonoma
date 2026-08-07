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
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { StackIcon } from "@phosphor-icons/react/Stack";
import { TrashIcon } from "@phosphor-icons/react/Trash";
import { PasteEnvDialog } from "../../../_app-shell/app.$appSlug/settings/previews/-variables/paste-env-dialog";
import {
  SERVICE_OPTIONS,
  serviceEnvRow,
  serviceRecipeUsesCustomImage,
  type ServiceDraft,
  type ServiceEnvDraft,
  type ServiceReadinessDraft,
  type ServiceReadinessKind,
} from "./topology-draft";

interface ServiceCardProps {
  service: ServiceDraft;
  onUpdate: (patch: Partial<ServiceDraft>) => void;
  onRemove: () => void;
}

/** One managed service instance's editable configuration (name, version/image, advanced options). */
export function ServiceCard({ service, onUpdate, onRemove }: ServiceCardProps) {
  const option = SERVICE_OPTIONS.find((candidate) => candidate.recipe === service.recipe);
  const label = option?.label ?? service.recipe;
  const customImage = serviceRecipeUsesCustomImage(service.recipe);
  return (
    <div className="border border-border-dim">
      <div className="flex items-center gap-3 border-b border-border-dim bg-surface-raised px-4 py-3">
        <StackIcon size={18} className="text-text-secondary" />
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
        {customImage ? (
          <div className="sm:col-span-2">
            <ServiceEnvEditor service={service} onUpdate={onUpdate} />
          </div>
        ) : undefined}
        {customImage ? (
          <details className="sm:col-span-2">
            <summary className="cursor-pointer font-mono text-2xs uppercase tracking-widest text-text-secondary">
              Advanced service config
            </summary>
            <div className="mt-4">
              <CustomImageAdvanced service={service} onUpdate={onUpdate} />
            </div>
          </details>
        ) : undefined}
      </div>
    </div>
  );
}

/** Plain key/value environment variables passed into a docker-image service's container. */
function ServiceEnvEditor({
  service,
  onUpdate,
}: {
  service: ServiceDraft;
  onUpdate: (patch: Partial<ServiceDraft>) => void;
}) {
  function updateRow(id: number, patch: Partial<ServiceEnvDraft>) {
    onUpdate({ env: service.env.map((row) => (row.id === id ? { ...row, ...patch } : row)) });
  }

  function removeRow(id: number) {
    onUpdate({ env: service.env.filter((row) => row.id !== id) });
  }

  function addRow() {
    onUpdate({ env: [...service.env, serviceEnvRow()] });
  }

  // Bulk-import a pasted `.env`: named keys merge in place (new ones append),
  // blank-key rows are left untouched so a half-typed row isn't dropped.
  function importDotenv(entries: Array<{ key: string; value: string }>) {
    if (entries.length === 0) return;
    const blanks = service.env.filter((row) => row.key.trim() === "");
    const byKey = new Map(service.env.filter((row) => row.key.trim() !== "").map((row) => [row.key.trim(), row]));
    for (const { key, value } of entries) {
      const trimmed = key.trim();
      if (trimmed === "") continue;
      const current = byKey.get(trimmed);
      byKey.set(trimmed, current != null ? { ...current, value } : serviceEnvRow(trimmed, value));
    }
    onUpdate({ env: [...byKey.values(), ...blanks] });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex items-center gap-2 font-mono text-2xs font-bold uppercase tracking-wider text-text-secondary">
          <span className="size-1.5 bg-primary" />
          Environment variables
        </p>
        <span className="border border-border-mid px-1.5 py-0.5 font-mono text-3xs text-text-secondary">
          {service.env.length}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <PasteEnvDialog
            description="Add every variable at once. Each KEY=value becomes an environment variable passed to the container. Existing keys are updated."
            onImport={importDotenv}
          />
          <Button variant="cta" size="sm" className="gap-1" onClick={addRow}>
            <PlusIcon size={12} weight="bold" />
            Add env var
          </Button>
        </div>
      </div>

      {service.env.length === 0 ? (
        <div className="flex items-center justify-center border border-border-dim px-6 py-14 text-center">
          <p className="font-mono text-2xs uppercase tracking-widest text-text-secondary">No variables yet</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {service.env.map((row) => (
            <div key={row.id} className="grid grid-cols-[minmax(7rem,0.5fr)_minmax(10rem,1fr)_auto] items-center gap-2">
              <Input
                aria-label="Env var name"
                value={row.key}
                onChange={(event) => updateRow(row.id, { key: event.target.value })}
                placeholder="LOG_LEVEL"
                className="font-mono"
              />
              <Input
                aria-label="Env var value"
                value={row.value}
                onChange={(event) => updateRow(row.id, { value: event.target.value })}
                placeholder="info"
                className="font-mono"
              />
              <Button
                variant="ghost"
                size="icon-sm"
                title="Remove env var"
                aria-label="Remove env var"
                onClick={() => removeRow(row.id)}
              >
                <TrashIcon size={14} />
              </Button>
            </div>
          ))}
        </div>
      )}
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
