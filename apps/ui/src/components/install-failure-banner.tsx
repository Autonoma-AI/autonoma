import { cn } from "@autonoma/blacklight";
import { InfoIcon } from "@phosphor-icons/react/Info";
import { WarningCircleIcon } from "@phosphor-icons/react/WarningCircle";
import {
  type InstallFailure,
  installFailureBody,
  installFailureManageLabel,
  installFailureSteps,
  installFailureTitle,
  installFailureTone,
} from "lib/github-install-errors";

interface InstallFailureBannerProps extends InstallFailure {
  /** Error code from the install callback. */
  error: string;
  /** GitHub page for the installation the steps tell the user to uninstall. */
  manageUrl?: string;
  className?: string;
}

/**
 * One treatment for every failed GitHub install, wherever it lands.
 *
 * It exists because the same failure used to look like two different products: a red banner with
 * numbered steps on the settings page, and a bare standalone card with a paragraph of prose on the
 * install-result page. The card was the one most people saw, and it was the one without the steps.
 */
export function InstallFailureBanner({ error, manageUrl, className, ...failure }: InstallFailureBannerProps) {
  const steps = installFailureSteps(error, failure);
  const tone = installFailureTone(error);
  const isCritical = tone === "critical";

  return (
    <div
      className={cn(
        "flex items-start gap-3 border px-5 py-4 text-left",
        isCritical ? "border-status-critical/30 bg-status-critical/5" : "border-primary-ink/30 bg-primary-ink/5",
        className,
      )}
    >
      {isCritical ? (
        <WarningCircleIcon size={20} weight="fill" className="mt-0.5 shrink-0 text-status-critical" />
      ) : (
        <InfoIcon size={20} weight="fill" className="mt-0.5 shrink-0 text-primary-ink" />
      )}
      <div className="space-y-2">
        <p className="text-sm font-medium text-text-primary">{installFailureTitle(error)}</p>
        <p className="text-xs text-text-secondary">{installFailureBody(error, failure)}</p>
        {steps.length > 0 && (
          <ol className="list-decimal space-y-1 pl-4 text-xs text-text-secondary marker:text-text-secondary">
            {steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        )}
        {manageUrl != null && (
          <a
            href={manageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block font-mono text-2xs text-primary-ink underline underline-offset-2"
          >
            {installFailureManageLabel(error, failure)}
          </a>
        )}
      </div>
    </div>
  );
}
