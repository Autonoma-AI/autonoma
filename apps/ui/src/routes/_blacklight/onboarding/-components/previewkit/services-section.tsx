import { Input, Label, Switch, cn } from "@autonoma/blacklight";
import { CheckSquareIcon } from "@phosphor-icons/react/CheckSquare";
import { DatabaseIcon } from "@phosphor-icons/react/Database";
import { AppEnvEditor } from "./app-env-editor";
import {
  SERVICE_OPTIONS,
  nextDraftId,
  type EnvRowDraft,
  type ServiceDraft,
  type ServiceRecipe,
} from "./topology-draft";

interface ServicesSectionProps {
  services: ServiceDraft[];
  onChange: (services: ServiceDraft[]) => void;
}

/**
 * Managed services come from the recipe catalog (not from repos), so they are a
 * separate section from deployable apps: no entrypoints, just recipe + version.
 */
export function ServicesSection({ services, onChange }: ServicesSectionProps) {
  function toggleRecipe(recipe: ServiceRecipe) {
    const existing = services.find((service) => service.recipe === recipe);
    if (existing != null) {
      onChange(services.filter((service) => service.recipe !== recipe));
      return;
    }
    const option = SERVICE_OPTIONS.find((candidate) => candidate.recipe === recipe);
    onChange([
      ...services,
      {
        id: nextDraftId(),
        recipe,
        name: option?.defaultName ?? recipe,
        version: option?.version ?? "",
        env: [],
        s3: false,
        sqs: false,
        sns: false,
      },
    ]);
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
      <div className="grid gap-3 p-5 sm:grid-cols-2">
        {SERVICE_OPTIONS.map((option) => {
          const active = services.find((service) => service.recipe === option.recipe);
          return (
            <div
              key={option.recipe}
              className={cn(
                "border transition-colors",
                active != null ? "border-primary-ink bg-primary-ink/10" : "border-border-dim hover:border-border-mid",
              )}
            >
              <button type="button" onClick={() => toggleRecipe(option.recipe)} className="w-full p-4 text-left">
                <div className="flex items-center gap-3">
                  <span className={active != null ? "text-primary-ink" : "text-text-secondary"}>
                    {active != null ? <CheckSquareIcon size={18} weight="fill" /> : <DatabaseIcon size={18} />}
                  </span>
                  <span className="font-medium text-text-primary">{option.label}</span>
                  <span className="ml-auto font-mono text-2xs text-text-secondary">{option.meta}</span>
                </div>
              </button>
              {active != null ? (
                <div className="grid gap-3 border-t border-border-dim p-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor={`pk-service-${active.id}-name`}>Name</Label>
                    <Input
                      id={`pk-service-${active.id}-name`}
                      value={active.name}
                      onChange={(event) => updateService(active.id, { name: event.target.value })}
                      placeholder={option.defaultName}
                      className="font-mono"
                    />
                  </div>
                  <div>
                    <Label htmlFor={`pk-service-${active.id}-version`}>Version</Label>
                    <Input
                      id={`pk-service-${active.id}-version`}
                      value={active.version}
                      onChange={(event) => updateService(active.id, { version: event.target.value })}
                      placeholder={option.version ?? "latest"}
                      className="font-mono"
                    />
                  </div>
                  <details className="sm:col-span-2">
                    <summary className="cursor-pointer font-mono text-2xs uppercase tracking-widest text-text-secondary">
                      Advanced service config
                    </summary>
                    <div className="mt-4">
                      <AppEnvEditor
                        appDraftId={active.id}
                        rows={active.env}
                        referenceTokens={[]}
                        title="Service env"
                        addLabel="Add env"
                        emptyLabel="No service environment variables."
                        onChange={(env: EnvRowDraft[]) => updateService(active.id, { env })}
                      />
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-3">
                      <ServiceSwitch
                        id={`pk-service-${active.id}-s3`}
                        label="S3"
                        checked={active.s3}
                        onChange={(s3) => updateService(active.id, { s3 })}
                      />
                      <ServiceSwitch
                        id={`pk-service-${active.id}-sqs`}
                        label="SQS"
                        checked={active.sqs}
                        onChange={(sqs) => updateService(active.id, { sqs })}
                      />
                      <ServiceSwitch
                        id={`pk-service-${active.id}-sns`}
                        label="SNS"
                        checked={active.sns}
                        onChange={(sns) => updateService(active.id, { sns })}
                      />
                    </div>
                  </details>
                </div>
              ) : undefined}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ServiceSwitch({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between border border-border-dim px-3 py-2">
      <Label htmlFor={id}>{label}</Label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
