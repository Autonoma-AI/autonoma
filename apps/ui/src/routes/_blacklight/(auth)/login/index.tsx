import { Badge, BrailleSpinner, Button, Skeleton } from "@autonoma/blacklight";
import { LAST_SOCIAL_PROVIDER_COOKIE, isPreviewHostname } from "@autonoma/types";
import { GithubLogoIcon } from "@phosphor-icons/react/GithubLogo";
import { createFileRoute } from "@tanstack/react-router";
import { Google } from "components/icons/google";
import { Microsoft } from "components/icons/microsoft";
import { env } from "env";
import { useAuthClient } from "lib/auth";
import { postSignInUrl } from "lib/auth-redirect";
import { ensureSocialProvidersData, useSocialProviders } from "lib/query/auth.queries";
import { toastManager } from "lib/toast-manager";
import type { RouterOutputs } from "lib/trpc";
import * as React from "react";
import { EmailPasswordForm } from "./-components/email-password-form";

export const Route = createFileRoute("/_blacklight/(auth)/login/")({
  component: LoginPage,
  loader: async ({ context: { queryClient } }) => {
    await ensureSocialProvidersData(queryClient);
  },
  validateSearch: (search: Record<string, unknown>): { error?: string; redirectTo?: string } => {
    const parsed: { error?: string; redirectTo?: string } = {};
    if (typeof search.error === "string") parsed.error = search.error;
    if (typeof search.redirectTo === "string") parsed.redirectTo = search.redirectTo;
    return parsed;
  },
});

function useIsPreviewEnvironment() {
  return isPreviewHostname(window.location.hostname, env.VITE_INTERNAL_DOMAIN);
}

type SocialProvider = RouterOutputs["auth"]["socialProviders"][number];

interface SocialProviderPresentation {
  label: string;
  icon: React.ReactNode;
}

// Presentation only - which of these are offered is the server's call, not this map's.
const SOCIAL_PROVIDER_PRESENTATION: Record<SocialProvider, SocialProviderPresentation> = {
  google: { label: "Continue with Google", icon: <Google /> },
  github: { label: "Continue with GitHub", icon: <GithubLogoIcon weight="fill" className="size-4" /> },
  microsoft: { label: "Continue with Microsoft", icon: <Microsoft /> },
};

const LAST_SOCIAL_PROVIDER_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * Remember the provider on the way out, from the browser.
 *
 * The API cannot do this. On beta and on every alpha the sign-in is proxied: production
 * completes the exchange and hands the profile back, so the session is minted at
 * `/oauth-proxy-callback` rather than `/callback/:id`, and an auth hook keyed on the
 * callback route never runs there. Recording it at the click happens on the originating
 * origin, before any redirect, so it behaves identically everywhere.
 *
 * Host-scoped on purpose - no `domain` attribute. Scoping it to `.autonoma.app` would
 * share one value across production, beta and every alpha, so an alpha would show you
 * whichever provider you last used on production.
 *
 * The trade is that this records the last provider *attempted* rather than the last one
 * that succeeded. Worth it: the previous version recorded the truth and then failed to
 * store it anywhere the proxied environments could read.
 */
function rememberProvider(provider: SocialProvider) {
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    `${LAST_SOCIAL_PROVIDER_COOKIE}=${provider}; path=/; ` +
    `max-age=${LAST_SOCIAL_PROVIDER_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

/**
 * The provider this browser last signed in with, if it is one we still offer. Steering a
 * returning user back to the same provider is what stops them signing up a second time:
 * a GitHub account whose email differs from their Google one is a different user, and a
 * different organization with it.
 */
function useLastSocialProvider(providers: readonly SocialProvider[]): SocialProvider | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${LAST_SOCIAL_PROVIDER_COOKIE}=([^;]*)`));
  const value = match?.[1];
  if (value == null) return undefined;
  return providers.find((provider) => provider === decodeURIComponent(value));
}

/** Last-used provider first, everything else in the order the server gave. */
function orderByLastUsed(
  providers: readonly SocialProvider[],
  lastUsed: SocialProvider | undefined,
): readonly SocialProvider[] {
  if (lastUsed == null) return providers;
  const rest = providers.filter((provider) => provider !== lastUsed);
  return [lastUsed, ...rest];
}

function signInFailedToast() {
  toastManager.add({
    type: "critical",
    title: "Sign in failed",
    description: "Something went wrong. Please try again.",
  });
}

function useSocialSignIn() {
  const authClient = useAuthClient();
  const { redirectTo } = Route.useSearch();
  const [pendingProvider, setPendingProvider] = React.useState<SocialProvider | undefined>(undefined);

  const signIn = async (provider: SocialProvider) => {
    setPendingProvider(provider);
    rememberProvider(provider);
    try {
      const { error } = await authClient.signIn.social({
        provider,
        // Lands on the organization picker, which forwards to `redirectTo` once there is an
        // organization to act as. Validated: this survives the round trip through the provider and
        // is then handed to the browser, so an unchecked value here is an open redirect.
        callbackURL: postSignInUrl(window.location.origin, redirectTo),
        errorCallbackURL: `${window.location.origin}/login`,
      });
      // The client resolves with `{ error }` rather than throwing (better-fetch only
      // throws when configured to), so a failed request lands here, not in the catch.
      // Without this the button would sit on "Signing in..." forever.
      if (error != null) {
        setPendingProvider(undefined);
        signInFailedToast();
      }
      // A success never reaches this point - better-auth has already navigated away.
    } catch {
      setPendingProvider(undefined);
      signInFailedToast();
    }
  };

  return { signIn, pendingProvider };
}

function useDotSpotlight() {
  const rafRef = React.useRef<number | undefined>(undefined);

  const setSpotlightPosition = (element: HTMLDivElement, clientX: number, clientY: number) => {
    const rect = element.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;

    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      element.style.setProperty("--mx", `${x}px`);
      element.style.setProperty("--my", `${y}px`);
    });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    setSpotlightPosition(event.currentTarget, event.clientX, event.clientY);
  };

  const onPointerLeave = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      element.style.setProperty("--mx", "50%");
      element.style.setProperty("--my", "50%");
    });
  };

  React.useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return { onPointerMove, onPointerLeave };
}

function useErrorFromSearch() {
  const { error } = Route.useSearch();
  const navigate = Route.useNavigate();

  React.useEffect(() => {
    if (error == null) return;

    toastManager.add({
      type: "critical",
      title: "Sign in failed",
      description: "Something went wrong. Please try again.",
    });

    void navigate({ search: (prev) => ({ ...prev, error: undefined }), replace: true });
  }, [error, navigate]);
}

interface SocialSignInButtonProps {
  provider: SocialProvider;
  /** The provider whose redirect is in flight, if any - every button disables while one runs. */
  pendingProvider?: SocialProvider;
  isLastUsed: boolean;
  onSignIn: (provider: SocialProvider) => Promise<void>;
}

function SocialSignInButton({ provider, pendingProvider, isLastUsed, onSignIn }: SocialSignInButtonProps) {
  const isPending = pendingProvider === provider;
  const { label, icon } = SOCIAL_PROVIDER_PRESENTATION[provider];

  return (
    <Button
      variant={isLastUsed ? "secondary" : "outline"}
      size="lg"
      className="w-full gap-3"
      onClick={() => void onSignIn(provider)}
      disabled={pendingProvider != null}
    >
      {isPending ? <BrailleSpinner animation="braille" size="sm" /> : icon}
      <span>{isPending ? "Signing in..." : label}</span>
      {isLastUsed && !isPending && (
        <Badge variant="outline" className="ml-auto font-mono text-4xs uppercase tracking-wider">
          Last used
        </Badge>
      )}
    </Button>
  );
}

function SocialSignIn() {
  const { signIn, pendingProvider } = useSocialSignIn();
  const { data: providers } = useSocialProviders();
  const lastUsed = useLastSocialProvider(providers);

  return (
    <>
      {orderByLastUsed(providers, lastUsed).map((provider) => (
        <SocialSignInButton
          key={provider}
          provider={provider}
          pendingProvider={pendingProvider}
          isLastUsed={provider === lastUsed}
          onSignIn={signIn}
        />
      ))}
    </>
  );
}

export function SocialSignInSkeleton() {
  return (
    <>
      <Skeleton className="h-11 w-full" />
      <Skeleton className="h-11 w-full" />
    </>
  );
}

function LoginPage() {
  const dotSpotlight = useDotSpotlight();
  const isPreview = useIsPreviewEnvironment();
  useErrorFromSearch();

  return (
    <div
      className="relative flex h-full items-center justify-center overflow-hidden bg-surface-void"
      onPointerMove={dotSpotlight.onPointerMove}
      onPointerLeave={dotSpotlight.onPointerLeave}
      style={{ "--mx": "50%", "--my": "50%" } as React.CSSProperties}
    >
      <div
        className="pointer-events-none absolute inset-0 z-10"
        style={{
          backgroundSize: "24px 24px",
          backgroundImage: "radial-gradient(circle at center, rgba(255, 255, 255, 0.10) 1px, transparent 1px)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 z-20"
        style={{
          backgroundSize: "24px 24px",
          backgroundImage: "radial-gradient(circle at center, rgba(255, 255, 255, 0.35) 1px, transparent 1px)",
          WebkitMaskImage:
            "radial-gradient(180px circle at var(--mx, 50%) var(--my, 50%), rgba(0, 0, 0, 1), rgba(0, 0, 0, 0))",
          maskImage:
            "radial-gradient(180px circle at var(--mx, 50%) var(--my, 50%), rgba(0, 0, 0, 1), rgba(0, 0, 0, 0))",
        }}
      />

      <div className="relative z-30 flex w-full max-w-md flex-col items-center px-6">
        <h1 className="text-center text-3xl font-medium tracking-tight text-text-primary">
          Set up your AI testing agent
        </h1>
        <p className="mt-3 text-center font-mono text-sm text-text-secondary">
          Sign in to connect your app and let AI agents automatically find bugs - no test scripts required.
        </p>

        <div className="mt-8 flex w-full flex-col gap-3">
          {isPreview ? (
            <EmailPasswordForm />
          ) : (
            <React.Suspense fallback={<SocialSignInSkeleton />}>
              <SocialSignIn />
            </React.Suspense>
          )}
        </div>

        <div className="mt-8 flex flex-wrap justify-center gap-2">
          {["AI-powered", "Zero scripts", "Self-healing"].map((item) => (
            <Badge key={item} variant="outline" className="font-mono text-3xs uppercase tracking-wider">
              {item}
            </Badge>
          ))}
        </div>
      </div>
    </div>
  );
}
