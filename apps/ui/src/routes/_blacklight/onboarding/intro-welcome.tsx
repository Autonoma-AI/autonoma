import { Card, CardContent, Separator } from "@autonoma/blacklight";
import { BrowserIcon } from "@phosphor-icons/react/Browser";
import { ClockIcon } from "@phosphor-icons/react/Clock";
import { DeviceMobileIcon } from "@phosphor-icons/react/DeviceMobile";
import { FlaskIcon } from "@phosphor-icons/react/Flask";
import { GlobeIcon } from "@phosphor-icons/react/Globe";
import { TreeStructureIcon } from "@phosphor-icons/react/TreeStructure";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { IntroNavButtons } from "./-components/intro-nav-buttons";
import { OnboardingPageHeader } from "./-components/onboarding-page-header";
import { AnimatedProcessRow, StageCard } from "./-components/stage-card";

export const Route = createFileRoute("/_blacklight/onboarding/intro-welcome")({
  component: () => <Navigate to="/onboarding" search={{ step: "intro-welcome", appId: undefined }} />,
});

export function IntroWelcomePage() {
  return (
    <>
      <OnboardingPageHeader
        title="Welcome to Autonoma"
        description={
          <p>
            Autonoma is an AI-powered end-to-end testing platform. Our agent analyzes your codebase, generates tests
            automatically, and runs them on real browsers - no test code to write, no manual configuration required.
          </p>
        }
      />

      <section className="space-y-4">
        <h2 className="font-mono text-2xs uppercase tracking-widest text-text-tertiary">
          How It Works - Visual Process
        </h2>

        <div className="relative grid gap-4 lg:grid-cols-3">
          <div className="pointer-events-none absolute left-1/4 right-1/4 top-20 hidden border-t border-border-dim lg:block" />

          {/* Stage 1 - Codebase Analysis */}
          <StageCard
            stageIndex={0}
            number={1}
            icon={<BrowserIcon size={16} weight="duotone" className="text-primary" />}
            title="Codebase Analysis"
            description="The agent maps routes, UI patterns, and interaction points in your application."
            visual={
              <div className="relative h-full overflow-hidden p-4">
                <div className="absolute bottom-3 left-5 top-3 w-px bg-border-mid" aria-hidden />
                <div
                  className="intro-welcome-scan-line motion-reduce:animate-none pointer-events-none absolute left-4 right-3 z-10 h-0.5 rounded-full bg-primary shadow-[0_0_14px_var(--color-primary)]"
                  aria-hidden
                />
                <div className="relative z-0 space-y-3 pt-2">
                  <AnimatedProcessRow rowIndex={0} widthClassName="w-20" />
                  <AnimatedProcessRow rowIndex={1} widthClassName="w-28" />
                  <AnimatedProcessRow rowIndex={2} widthClassName="w-24" accent />
                  <AnimatedProcessRow rowIndex={3} widthClassName="w-16" />
                </div>
              </div>
            }
          />

          {/* Stage 2 - Test Planning */}
          <StageCard
            stageIndex={1}
            number={2}
            icon={<TreeStructureIcon size={16} weight="duotone" className="text-primary" />}
            title="Test Planning"
            description="Autonoma organizes flow coverage and prepares scenario-aware test environments."
            visual={
              <div className="flex h-full items-center justify-center">
                <div className="intro-welcome-ring-appear relative size-24">
                  <div className="absolute inset-0 rounded-full border border-border-mid" aria-hidden />
                  <span
                    className="absolute left-1/2 top-0 z-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-tertiary"
                    aria-hidden
                  />
                  <span
                    className="absolute right-0 top-1/2 z-0 size-2 translate-x-1/2 -translate-y-1/2 rounded-full bg-text-tertiary"
                    aria-hidden
                  />
                  <span
                    className="absolute bottom-0 left-1/2 z-0 size-2 -translate-x-1/2 translate-y-1/2 rounded-full bg-text-tertiary"
                    aria-hidden
                  />
                  <span
                    className="absolute left-0 top-1/2 z-0 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-text-tertiary"
                    aria-hidden
                  />
                  <div className="intro-welcome-orbit absolute inset-0 z-10" aria-hidden>
                    <div className="absolute left-1/2 top-0 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_10px_var(--color-primary)]" />
                  </div>
                </div>
              </div>
            }
          />

          {/* Stage 3 - Test Generation */}
          <StageCard
            stageIndex={2}
            number={3}
            icon={<FlaskIcon size={16} weight="duotone" className="text-primary" />}
            title="Test Generation"
            description="Generated tests are run on real browsers with visual validation and replayable outputs."
            visual={
              <div className="h-full p-4">
                <div className="flex h-full flex-col justify-center gap-3 rounded-md border border-border-mid bg-surface-base/60 p-3">
                  <AnimatedProcessRow rowIndex={0} widthClassName="w-24" />
                  <AnimatedProcessRow rowIndex={1} widthClassName="w-16" />
                  <AnimatedProcessRow rowIndex={2} widthClassName="w-28" accent />
                </div>
              </div>
            }
          />
        </div>

        <p className="text-sm leading-relaxed text-text-secondary">
          During setup, you'll install the Autonoma plugin in Claude Code and watch the agent perform all three stages
          automatically in your project.
        </p>
      </section>

      <Separator className="my-10 bg-border-dim" />

      <div className="space-y-4">
        <Card className="border-status-warn/30 bg-status-warn/5">
          <CardContent className="flex items-start gap-4">
            <DeviceMobileIcon size={20} weight="duotone" className="mt-0.5 shrink-0 text-status-warn" />
            <div>
              <p className="text-sm font-medium text-text-primary">Building a mobile app?</p>
              <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                This self-service onboarding is for web applications. If you have an iOS or Android app and want to set
                up mobile testing, please{" "}
                <a
                  href="mailto:support@autonoma.app"
                  className="font-medium text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
                >
                  contact our team
                </a>{" "}
                and we'll get you set up.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-status-warn/30 bg-status-warn/5">
          <CardContent className="flex items-start gap-4">
            <GlobeIcon size={20} weight="duotone" className="mt-0.5 shrink-0 text-status-warn" />
            <div>
              <p className="text-sm font-medium text-text-primary">Preview environments required</p>
              <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                Autonoma runs tests against a deployed URL - typically a staging or preview environment. If you don't
                have one set up yet,{" "}
                <a
                  href="https://cal.com/eugenio-scafati/preview-environments-chat"
                  target="_blank"
                  rel="noreferrer"
                  className="font-medium text-primary underline decoration-primary/30 underline-offset-2 hover:decoration-primary"
                >
                  book a call
                </a>{" "}
                and we'll help you get one running before onboarding.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="flex items-start gap-4">
            <ClockIcon size={20} weight="duotone" className="mt-0.5 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-medium text-text-primary">Set aside 30 minutes to 2 hours</p>
              <p className="mt-1 text-sm leading-relaxed text-text-secondary">
                The full setup - including codebase analysis, test generation, and configuration - typically takes
                between 30 minutes and 2 hours depending on your project size. We recommend starting when you have some
                free time so you can complete the process in one sitting.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-10">
        <IntroNavButtons nextTo="/onboarding" nextSearch={{ step: "intro-key-concepts" }} nextLabel="Continue" />
      </div>
    </>
  );
}
