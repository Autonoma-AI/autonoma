import { DEPLOYMENT_SIGNAL_SECRET_NAME } from "@autonoma/types";
import type { Icon } from "@phosphor-icons/react/lib";
import { LockSimpleIcon } from "@phosphor-icons/react/LockSimple";
import { PlugsConnectedIcon } from "@phosphor-icons/react/PlugsConnected";
import { StackIcon } from "@phosphor-icons/react/Stack";
import { useAvailableVercelProjects } from "lib/onboarding/onboarding-api";

/**
 * The "Integration taking shape" cards, for apps whose previews come from the
 * customer's own pipeline.
 *
 * Same slot and grammar as {@link PreviewTakingShape}, which only makes sense
 * for previews Autonoma builds. Without this the panel is simply absent on the
 * path where the user has the least visible feedback - their pipeline is doing
 * the work off-screen - so the screen reads as though less is happening exactly
 * when reassurance matters most. What feeds the integration on top, what comes
 * out of it lives below in the signal status, exactly as the deploy status sits
 * under the topology for an Autonoma-hosted preview.
 *
 * Which source is shown is INFERRED from a linked Vercel project: the provider
 * the user picked is a URL search param on the setup screen, never persisted, so
 * a Vercel connection is the only durable evidence of it. Everything else falls
 * back to the signed-webhook wording, which is true regardless of what emits it.
 */
export function IntegrationTakingShape({ applicationId }: { applicationId: string }) {
  const { data } = useAvailableVercelProjects(applicationId);
  const vercelProject = data?.linkedProject?.name;

  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-center gap-1.5 font-mono text-2xs uppercase tracking-widest text-text-secondary">
        <StackIcon size={13} />
        Integration taking shape
      </p>

      <div className="flex flex-col gap-1.5">
        <ShapeCard
          icon={PlugsConnectedIcon}
          kicker="signal source"
          value={vercelProject != null ? `Vercel · ${vercelProject}` : "Your pipeline · signed webhook"}
        />
        <ShapeCard
          icon={LockSimpleIcon}
          kicker="authentication"
          value={`HMAC-SHA256 · ${DEPLOYMENT_SIGNAL_SECRET_NAME}`}
        />
      </div>

      <p className="pt-1 font-mono text-2xs text-text-secondary">
        Autonoma builds nothing here - your pipeline deploys as it always has, and tells us when a preview is live.
      </p>
    </div>
  );
}

function ShapeCard({ icon, kicker, value }: { icon: Icon; kicker: string; value: string }) {
  const CardIcon = icon;
  return (
    <div className="flex items-center gap-3 border border-border-dim bg-surface-void px-3 py-2">
      <CardIcon size={16} className="shrink-0 text-text-secondary" />
      <div className="flex min-w-0 flex-col">
        <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">{kicker}</span>
        <span className="truncate font-mono text-2xs text-text-primary">{value}</span>
      </div>
    </div>
  );
}
