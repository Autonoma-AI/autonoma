import { Button } from "@autonoma/blacklight";

interface LogAppFilterProps {
  /** App and service names the logs can be scoped to. */
  apps: string[];
  /** Currently selected app; one is always selected. */
  selectedApp: string | undefined;
  onSelect: (app: string) => void;
}

/**
 * Segmented selector that scopes a preview environment's logs to one app (one is
 * always selected). Active = secondary, inactive = outline, mirroring the other
 * preview toggles. Shared by the admin PreviewKit page and the onboarding deploy
 * step so both scope their logs to a single app at a time.
 */
export function LogAppFilter({ apps, selectedApp, onSelect }: LogAppFilterProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-0.5 font-mono text-3xs uppercase tracking-widest text-text-secondary">App</span>
      {apps.map((app) => (
        <Button
          key={app}
          variant={selectedApp === app ? "secondary" : "outline"}
          size="xs"
          aria-pressed={selectedApp === app}
          onClick={() => onSelect(app)}
        >
          {app}
        </Button>
      ))}
    </div>
  );
}
