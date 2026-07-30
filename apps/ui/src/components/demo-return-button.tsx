import { Button } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { getApiOrigin } from "lib/api-origin";
import { useActiveOrg } from "lib/query/auth.queries";

/**
 * Leaves the read-only demo and restores the session the visitor entered it with.
 * Renders nothing unless the server reports a parked session, so it is safe to mount
 * anywhere: visitors who arrived from the landing page have no account to return to.
 *
 * A real navigation, not a router link - the API must set the session cookie before the
 * app reloads under the restored identity.
 */
export function DemoReturnButton({ label = "Back to your account" }: { label?: string }) {
  const { data: activeOrg } = useActiveOrg();
  if (activeOrg?.canReturnToAccount !== true) return null;

  return (
    <Button size="xs" variant="accent" render={<a href={`${getApiOrigin()}/v1/demo/exit`} />}>
      <ArrowLeftIcon size={12} weight="bold" />
      {label}
    </Button>
  );
}
