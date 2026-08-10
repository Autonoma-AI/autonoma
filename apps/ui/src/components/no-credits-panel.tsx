import { WarningIcon } from "@phosphor-icons/react/Warning";
import { Link } from "@tanstack/react-router";
import { useApplicationSlug } from "lib/query/applications.queries";
import { useFreeStartEligibility } from "lib/query/billing.queries";

/**
 * Stands in for the setup command when the organization has no credits to run it with.
 *
 * It replaces the command rather than warning beside it, because the command cannot work: the planner
 * spends credits on its first generation, so offering it on a zero balance is offering a failure. The
 * manual path goes with it - configuring previews by hand leaves somebody stuck one step later, having
 * done the work.
 *
 * Eligibility only supplies the reason. It is deliberately not the gate: an account whose entitlement
 * went elsewhere but which has since paid has credits and must be let through, and an account that is
 * still entitled but has spent its balance has none and must not be. Balance decides, entitlement
 * explains - see the caller.
 */
export function NoCreditsPanel({ applicationId }: { applicationId: string }) {
  const { data: eligibility } = useFreeStartEligibility();
  const applicationSlug = useApplicationSlug(applicationId);
  const spentElsewhere = eligibility != null && !eligibility.eligible ? eligibility.blockedBy : [];
  const [first, ...rest] = spentElsewhere;

  return (
    <div className="flex flex-col gap-4 border border-status-warn/50 bg-surface-raised p-5">
      <div className="flex items-start gap-3">
        <WarningIcon size={18} className="mt-0.5 shrink-0 text-status-warn" />
        <div className="flex flex-col gap-2">
          <h3 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">
            Add credits to continue
          </h3>
          <p className="max-w-xl text-2xs leading-relaxed text-text-secondary">
            Setting an application up spends credits, so there is nothing useful to run yet.
            {first != null && (
              <>
                {" "}
                The free starting credits are one per account, and yours went to{" "}
                <span className="text-text-primary">{first.name}</span>
                {rest.length > 0 && <> and {rest.length === 1 ? "1 other organization" : `${rest.length} others`}</>}.
              </>
            )}
          </p>
        </div>
      </div>
      {applicationSlug != null && (
        <Link
          to="/app/$appSlug/settings/billing"
          params={{ appSlug: applicationSlug }}
          className="self-start border border-primary bg-primary px-4 py-2 font-mono text-2xs font-bold uppercase tracking-widest text-primary-foreground transition-opacity hover:opacity-90"
        >
          Add credits
        </Link>
      )}
    </div>
  );
}
