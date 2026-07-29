import { EyeIcon } from "@phosphor-icons/react/Eye";
import { useActiveOrg } from "lib/query/auth.queries";
import { DemoSignupButton } from "./demo-signup-button";

/**
 * Persistent bar shown across every in-app page while the active org is the read-only
 * demo. Renders nothing otherwise, so it is safe to mount unconditionally. `isDemo` is
 * computed server-side on `auth.activeOrg` (the client never learns the demo org id).
 */
export function DemoBanner() {
  const { data: activeOrg } = useActiveOrg();
  if (activeOrg?.isDemo !== true) return null;

  return (
    <div className="relative z-20 flex shrink-0 items-center justify-center gap-3 border-b border-primary/30 bg-primary/10 px-6 py-2">
      <EyeIcon size={14} className="text-primary" weight="fill" />
      <span className="font-mono text-2xs text-text-primary">You're exploring a live, read-only demo of Autonoma.</span>
      <DemoSignupButton label="Sign up to build your own" />
    </div>
  );
}
