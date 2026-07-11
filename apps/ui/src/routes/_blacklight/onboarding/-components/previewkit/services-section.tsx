import { ArrowSquareOutIcon } from "@phosphor-icons/react/ArrowSquareOut";
import { CubeIcon } from "@phosphor-icons/react/Cube";
import { PlusIcon } from "@phosphor-icons/react/Plus";
import { ServiceCard } from "./service-card";
import { serviceDraftForRecipe, type ServiceDraft } from "./topology-draft";

const SERVICES_DOCS_URL = "https://docs.autonoma.app/previewkit/services/";

interface ServicesSectionProps {
  services: ServiceDraft[];
  /** All service names in the topology, so a freshly-added service gets a unique name. */
  existingNames: string[];
  onChange: (services: ServiceDraft[]) => void;
}

/**
 * Extra services are arbitrary Docker images that aren't databases - Sentry, an
 * OTel collector, an nginx, a mail catcher. Databases live in their own step, so
 * this palette only offers a custom Docker image, added via one big square
 * button.
 */
export function ServicesSection({ services, existingNames, onChange }: ServicesSectionProps) {
  function addService() {
    onChange([...services, serviceDraftForRecipe("docker-image", existingNames)]);
  }

  function removeService(id: number) {
    onChange(services.filter((service) => service.id !== id));
  }

  function updateService(id: number, patch: Partial<ServiceDraft>) {
    onChange(services.map((service) => (service.id === id ? { ...service, ...patch } : service)));
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex items-center gap-2 font-mono text-sm font-bold uppercase tracking-widest text-text-primary">
          Extra services
          <span className="border border-border-mid px-1.5 py-0.5 font-mono text-4xs uppercase tracking-widest text-text-secondary">
            Optional
          </span>
        </span>
        <span className="text-sm text-text-secondary">
          Extra Docker images that aren't databases - Sentry, OTel, nginx, a mail catcher.{" "}
          <a
            href={SERVICES_DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary-ink underline underline-offset-2"
          >
            Learn more
            <ArrowSquareOutIcon size={11} />
          </a>
        </span>
      </div>

      {services.map((service) => (
        <ServiceCard
          key={service.id}
          service={service}
          onUpdate={(patch) => updateService(service.id, patch)}
          onRemove={() => removeService(service.id)}
        />
      ))}

      <button
        type="button"
        onClick={addService}
        className="group flex w-full max-w-xs items-center gap-3 border border-dashed border-border-mid bg-surface-base p-4 text-left transition-colors hover:border-primary-ink/60 hover:bg-accent-dim"
      >
        <span className="flex size-10 items-center justify-center border border-border-mid text-text-secondary transition-colors group-hover:border-primary-ink group-hover:text-primary-ink">
          <CubeIcon size={20} />
        </span>
        <span className="flex flex-col gap-0.5">
          <span className="font-mono text-2xs font-bold uppercase tracking-widest text-text-primary">Add service</span>
          <span className="text-2xs text-text-secondary">Custom Docker image</span>
        </span>
        <PlusIcon
          size={16}
          weight="bold"
          className="ml-auto text-text-secondary transition-colors group-hover:text-primary-ink"
        />
      </button>
    </div>
  );
}
