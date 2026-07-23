import { Button, Skeleton } from "@autonoma/blacklight";
import { ArrowRightIcon } from "@phosphor-icons/react/ArrowRight";
import { CheckIcon } from "@phosphor-icons/react/Check";
import { CopyIcon } from "@phosphor-icons/react/Copy";
import { RobotIcon } from "@phosphor-icons/react/Robot";
import { SlidersIcon } from "@phosphor-icons/react/Sliders";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ConnectAgentInstall,
  ONBOARDING_MCP_DOCS_URL,
  ONBOARDING_MCP_SERVER_NAME,
} from "components/connect-agent-dialog";
import { useCreateAgentPairing } from "lib/onboarding/onboarding-api";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { useEffect, useRef, useState } from "react";
import { AgentConfiguringScreen } from "./agent-configuring-screen";

/**
 * How long the cube's connect spin-up plays before handing off to the live
 * configuring screen - the single source for both the handoff timer and the
 * `mcpCubeAccel` / `mcpCubeBlur` animation durations (derived in {@link ConnectionCube}).
 * The beat is purely cosmetic: the agent is already paired and working; this just
 * marks the transition.
 */
const CUBE_SPINUP_MS = 3400;
const CUBE_SPINUP_SECONDS = CUBE_SPINUP_MS / 1000;
/** Extra beat holding on "Connected - starting setup" after the spin-up, before the handoff. */
const CONNECTED_DWELL_MS = 1000;

type Phase = "waiting" | "connected" | "configuring";

/**
 * The MCP-first headline for the config-previews step: the coding-agent path
 * rendered full-page (pairing code + install snippets on the left, a 3D wireframe
 * cube on the right) instead of behind a modal, with the manual stepper demoted to
 * a link. It owns the waiting -> connect (cube spin-up) -> configuring transition:
 * once the agent pairs, the cube speeds up and turns lime, then the live
 * {@link AgentConfiguringScreen} takes over. A session that is already agent-held
 * (returning mid-config) skips the ceremony and lands straight on configuring.
 */
export function McpFirstConfigView({ appId, agentHeld }: { appId: string; agentHeld: boolean }) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>(agentHeld ? "configuring" : "waiting");

  // Pairing detected: the agent-session poll flipped `agentHeld`, so leave the idle
  // "waiting" state and let the cube spin up. Only the waiting -> connected edge.
  useEffect(() => {
    if (agentHeld && phase === "waiting") setPhase("connected");
  }, [agentHeld, phase]);

  // The agent released control (the user hit "Take over", or the session went idle
  // and released to stale) while we were showing the configuring screen. The config
  // is the human's now, so hand off to the manual editable form (?configStep) rather
  // than latching on the read-only screen - otherwise "Take over" looks like a no-op.
  useEffect(() => {
    if (agentHeld || phase !== "configuring") return;
    void navigate({
      to: "/onboarding",
      replace: true,
      search: buildOnboardingSearch("previewkit-config", appId, { configStep: "apps" }),
    });
  }, [agentHeld, phase, appId, navigate]);

  // Once connected, hold through the spin-up plus a short dwell on "Connected -
  // starting setup", then hand off to the live configuring screen. Keyed on `phase`
  // ALONE (not agentHeld) so a later poll can't re-run this effect and clear the
  // timer before it fires - which would strand the view on the connected cube.
  useEffect(() => {
    if (phase !== "connected") return;
    const timer = setTimeout(() => setPhase("configuring"), CUBE_SPINUP_MS + CONNECTED_DWELL_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (phase === "configuring") return <AgentConfiguringScreen applicationId={appId} />;

  return <McpFirstPairing appId={appId} connected={phase === "connected"} />;
}

function McpFirstPairing({ appId, connected }: { appId: string; connected: boolean }) {
  const createPairing = useCreateAgentPairing();

  // Mint one pairing code as the page opens - the code is shown immediately, no
  // click. Keyed by the app it minted for: guards React's dev double-mount (and
  // re-renders) for the same app, yet re-mints if the view stays mounted across an
  // appId change (else the shown code would stay pinned to the previous app).
  const mintedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (mintedFor.current === appId) return;
    mintedFor.current = appId;
    createPairing.mutate({ applicationId: appId });
  }, [appId, createPairing]);

  const code = createPairing.data?.code;

  return (
    <div className="flex flex-col gap-6">
      <div className="relative grid grid-cols-1 border border-primary lg:grid-cols-[minmax(0,1fr)_22rem]">
        <PanelCorners />

        <div className="flex flex-col gap-7 border-b border-border-mid bg-surface-base p-8 lg:border-b-0 lg:border-r">
          <div className="flex flex-col gap-3">
            <div className="flex size-10 items-center justify-center border border-primary-ink text-primary-ink shadow-[0_0_15px_var(--accent-glow)]">
              <RobotIcon size={20} weight="bold" />
            </div>
            <h2 className="font-mono text-sm font-bold uppercase tracking-widest text-text-primary">
              Configure with a coding agent
            </h2>
            <p className="max-w-xl text-2xs leading-relaxed text-text-secondary">
              Install the Autonoma MCP in your coding agent, then give it the pairing code below. It configures and
              deploys your preview while you watch here - no scripts, no YAML.
            </p>
          </div>

          <ConnectAgentInstall
            serverName={ONBOARDING_MCP_SERVER_NAME}
            endpoint="onboarding"
            docsUrl={ONBOARDING_MCP_DOCS_URL}
            pairing={
              <PairingCodeBlock
                code={code}
                pending={createPairing.isPending}
                error={createPairing.isError}
                onRetry={() => createPairing.mutate({ applicationId: appId })}
              />
            }
            tellAgent={
              <>
                Then tell your agent: <span className="font-mono text-text-primary">configure my preview</span>
                {code != null ? (
                  <>
                    {" "}
                    with code <span className="font-mono text-primary">{code}</span>.
                  </>
                ) : (
                  "."
                )}
              </>
            }
          />
        </div>

        <ConnectionCube connected={connected} />
      </div>

      {/* Once the agent connects this page is only a handoff beat before the
          configuring screen, so drop the manual escape hatch - otherwise someone
          could click into the manual stepper mid-handoff and desync the two flows. */}
      {connected ? undefined : (
        <div className="flex items-center justify-center gap-2 border-t border-border-dim pt-5">
          <span className="text-2xs text-text-secondary">Rather wire it up yourself?</span>
          <Link
            to="/onboarding"
            search={buildOnboardingSearch("previewkit-config", appId, { configStep: "apps" })}
            className="inline-flex items-center gap-1.5 font-mono text-2xs text-text-secondary transition-colors hover:text-text-primary"
          >
            <SlidersIcon size={13} weight="bold" />
            Configure manually
            <ArrowRightIcon size={13} weight="bold" />
          </Link>
        </div>
      )}
    </div>
  );
}

/** The prominent centered pairing code (or a skeleton / retry while it mints). */
function PairingCodeBlock({
  code,
  pending,
  error,
  onRetry,
}: {
  code?: string;
  pending: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="text-center font-mono text-2xs uppercase tracking-widest text-text-secondary">Pairing code</span>
      {pending ? (
        <Skeleton className="h-20 w-full" />
      ) : error || code == null ? (
        <div className="flex flex-col items-center gap-2 border border-status-critical/40 bg-surface-void p-5">
          <span className="text-2xs text-status-critical">Couldn't generate a pairing code.</span>
          <Button variant="outline" size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      ) : (
        <div className="relative flex items-center justify-center border border-border-mid bg-surface-void px-12 py-6">
          <span className="font-mono text-4xl tracking-[0.3em] text-primary">{code}</span>
          <CopyPairingCodeButton code={code} />
        </div>
      )}
    </div>
  );
}

/** Copies the pairing code; the icon flips to a check once copied. */
function CopyPairingCodeButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    // `navigator.clipboard` is undefined in insecure contexts, and the write can
    // reject (permissions, unfocused document) - handle both so the failure logs
    // instead of surfacing as an unhandled rejection, and the check stays false.
    if (navigator.clipboard == null) {
      console.warn("Clipboard API unavailable; cannot copy pairing code");
      return;
    }
    navigator.clipboard
      .writeText(code)
      .then(() => setCopied(true))
      .catch((err) => console.warn("Failed to copy pairing code", err));
  }

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="absolute right-2 top-1/2 -translate-y-1/2 bg-surface-void text-text-secondary"
      onClick={copy}
      aria-label="Copy pairing code"
    >
      {copied ? <CheckIcon className="text-status-success" /> : <CopyIcon />}
    </Button>
  );
}

/** Lime L-brackets at the four corners of the headline panel (matches the config-bar accents). */
function PanelCorners() {
  return (
    <>
      <span className="pointer-events-none absolute left-0 top-0 z-10 size-2 border-l border-t border-primary" />
      <span className="pointer-events-none absolute right-0 top-0 z-10 size-2 border-r border-t border-primary" />
      <span className="pointer-events-none absolute bottom-0 left-0 z-10 size-2 border-b border-l border-primary" />
      <span className="pointer-events-none absolute bottom-0 right-0 z-10 size-2 border-b border-r border-primary" />
    </>
  );
}

/** Face transforms of the 110px wireframe cube (each face is a bordered square pushed out half the edge). */
const CUBE_FACES = [
  "translateZ(55px)",
  "rotateY(180deg) translateZ(55px)",
  "rotateY(90deg) translateZ(55px)",
  "rotateY(-90deg) translateZ(55px)",
  "rotateX(90deg) translateZ(55px)",
  "rotateX(-90deg) translateZ(55px)",
];

/**
 * The connection status visual: a 3D wireframe cube idly wobbling in gray while
 * waiting to pair, then - on `connected` - turning lime, glowing, and whipping
 * through a decelerating spin-up (the "speedup") as the flow hands off to the live
 * configuring screen. Pure CSS (no animation library); keyframes are inlined the
 * same way the other onboarding animations (complete, preview-router-quiz) are.
 */
export function ConnectionCube({ connected }: { connected: boolean }) {
  const cubeColor = connected ? "var(--primary)" : "var(--text-secondary)";
  const glowColor = connected ? "var(--accent-glow)" : "rgba(120, 124, 132, 0.35)";
  const glowOpacity = connected ? 0.75 : 0.28;
  const spinAnimation = connected
    ? `mcpCubeAccel ${CUBE_SPINUP_SECONDS}s cubic-bezier(0.5, 0, 0.5, 1) forwards`
    : "none";
  const blurAnimation = connected ? `mcpCubeBlur ${CUBE_SPINUP_SECONDS}s linear forwards` : "none";
  const statusText = connected ? "Connected - starting setup" : "Waiting to pair...";
  const dotColor = connected ? "var(--status-success)" : "var(--status-pending)";

  return (
    <div className="relative flex flex-col items-center justify-center gap-9 overflow-hidden bg-surface-void p-10">
      <style>{`
        @keyframes mcpCubeWobble {
          0%   { transform: rotateX(-24deg) rotateY(-32deg) rotateZ(-4deg); }
          20%  { transform: rotateX(14deg)  rotateY(18deg)  rotateZ(3deg); }
          40%  { transform: rotateX(-8deg)  rotateY(44deg)  rotateZ(-2deg); }
          60%  { transform: rotateX(22deg)  rotateY(6deg)   rotateZ(5deg); }
          80%  { transform: rotateX(-16deg) rotateY(-20deg) rotateZ(-3deg); }
          100% { transform: rotateX(-24deg) rotateY(-32deg) rotateZ(-4deg); }
        }
        @keyframes mcpCubeAccel {
          0%   { transform: rotateY(0deg) rotateX(0deg); }
          100% { transform: rotateY(2520deg) rotateX(460deg); }
        }
        @keyframes mcpCubeBlur {
          0%   { filter: blur(0px); }
          25%  { filter: blur(0.35px); }
          50%  { filter: blur(1.2px); }
          75%  { filter: blur(0.35px); }
          100% { filter: blur(0px); }
        }
        @keyframes mcpCubeBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
      `}</style>

      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{
          backgroundImage: "radial-gradient(circle at center, rgba(194, 232, 18, 0.08) 1px, transparent 1px)",
          backgroundSize: "24px 24px",
        }}
      />

      <div className="relative flex items-center justify-center" style={{ width: 240, height: 220 }}>
        <div
          className="absolute"
          style={{
            width: 190,
            height: 190,
            background: `radial-gradient(circle, ${glowColor} 0%, transparent 68%)`,
            filter: "blur(14px)",
            opacity: glowOpacity,
            transition: "background 1.1s ease-out, opacity 1.1s ease-out",
          }}
        />
        <div
          className="flex items-center justify-center"
          style={{ width: 190, height: 190, perspective: "560px", animation: blurAnimation }}
        >
          <div
            style={{
              position: "relative",
              width: 110,
              height: 110,
              transformStyle: "preserve-3d",
              animation: spinAnimation,
            }}
          >
            <div
              style={{
                position: "relative",
                width: 110,
                height: 110,
                transformStyle: "preserve-3d",
                color: cubeColor,
                transition: "color 1.1s ease-out",
                // Rest pose matches the wobble keyframe's 0%/100% frame, so the cube
                // still reads as 3D before the animation starts and when motion is
                // reduced (the wobble overrides this while it runs).
                transform: "rotateX(-24deg) rotateY(-32deg) rotateZ(-4deg)",
                animation: "mcpCubeWobble 14s ease-in-out infinite",
              }}
            >
              {CUBE_FACES.map((face) => (
                <div
                  key={face}
                  style={{
                    position: "absolute",
                    width: 110,
                    height: 110,
                    border: "1.5px solid currentColor",
                    transform: face,
                  }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="relative flex flex-col items-center gap-2 text-center">
        <span className="font-sans text-base font-semibold text-text-primary">Autonoma Agent</span>
        <span className="flex items-center gap-2 font-mono text-2xs uppercase tracking-widest text-text-secondary">
          <span
            className="size-1.5"
            style={{
              background: dotColor,
              boxShadow: "0 0 8px var(--accent-glow)",
              animation: "mcpCubeBlink 1.6s infinite",
            }}
          />
          {statusText}
        </span>
      </div>
    </div>
  );
}
