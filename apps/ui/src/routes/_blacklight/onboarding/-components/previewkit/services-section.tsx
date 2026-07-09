import { Button } from "@autonoma/blacklight";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { ServiceCard } from "./service-card";
import { SERVICE_OPTIONS, serviceDraftForRecipe, type ServiceDraft, type ServiceRecipe } from "./topology-draft";

interface ServicesSectionProps {
  services: ServiceDraft[];
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
export function ServicesSection({ services, onChange }: ServicesSectionProps) {
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
              onUpdate={(patch) => updateService(service.id, patch)}
              onRemove={() => removeService(service.id)}
            />
          ))
        )}
      </div>
    </section>
  );
}
