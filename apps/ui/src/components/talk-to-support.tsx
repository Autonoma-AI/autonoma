import { Button } from "@autonoma/blacklight";
import { HeadsetIcon } from "@phosphor-icons/react/Headset";

export const SUPPORT_URL = "https://cal.com/nicolas-marcantonio/30min";

interface TalkToSupportProps {
  className?: string;
}

export function TalkToSupport({ className }: TalkToSupportProps) {
  return (
    <div className={className}>
      <a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" className="block">
        <Button variant="cta" size="lg" className="w-full gap-2.5 text-sm font-semibold">
          <HeadsetIcon size={20} weight="duotone" />
          Talk to Support
        </Button>
      </a>
      <p className="mt-2.5 text-center font-mono text-3xs text-text-tertiary">
        Getting stuck? Schedule a call with our team - we're happy to help.
      </p>
    </div>
  );
}
