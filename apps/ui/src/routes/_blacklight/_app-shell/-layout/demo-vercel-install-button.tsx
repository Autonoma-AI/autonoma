import { Button } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";

const VERCEL_MARKETPLACE_URL = "https://vercel.com/marketplace/autonoma-ai";

/**
 * Shown instead of the sign-up CTA for visitors who entered the demo from Vercel's
 * marketplace listing - a listing page can't push a direct external sign-up, so this
 * sends them back to the listing to install the integration instead.
 */
export function DemoVercelInstallButton() {
  return (
    <Button size="xs" variant="accent" render={<a href={VERCEL_MARKETPLACE_URL} />}>
      <ArrowLeftIcon size={12} weight="bold" />
      Back to Vercel to install
    </Button>
  );
}
