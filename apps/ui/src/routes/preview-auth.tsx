import { createFileRoute } from "@tanstack/react-router";
import { useAPIMutation } from "lib/query/api-queries";
import { trpc } from "lib/trpc";
import { useEffect } from "react";
import { z } from "zod";

export const Route = createFileRoute("/preview-auth")({
  validateSearch: z.object({
    redirect: z.string().url(),
  }),
  errorComponent: () => <ErrorPage message="Invalid or missing redirect URL." />,
  component: PreviewAuthPage,
});

function PreviewAuthPage() {
  const { redirect } = Route.useSearch();
  const issueToken = useAPIMutation(trpc.previewAccess.issueToken.mutationOptions());

  useEffect(() => {
    issueToken.mutate(
      { redirectUrl: redirect },
      {
        onSuccess: ({ token }) => {
          const url = new URL(redirect);
          const callbackUrl =
            `${url.origin}/preview-auth` +
            `?session=${encodeURIComponent(token)}` +
            `&next=${encodeURIComponent(redirect)}`;
          // Cross-origin redirect to the preview environment - TanStack Router cannot handle this
          window.location.href = callbackUrl;
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (issueToken.isError) {
    const isAccessDenied = issueToken.error.message.includes("not found or access denied");
    const message = isAccessDenied
      ? "Your account does not have access to this preview environment."
      : "Something went wrong while authenticating. Please try again.";
    return <ErrorPage message={message} />;
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-void">
      <p className="text-text-secondary text-sm">Authenticating...</p>
    </div>
  );
}

function ErrorPage({ message }: { message: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface-void">
      <div className="text-center space-y-2">
        <p className="text-text-primary text-sm font-medium">Access denied</p>
        <p className="text-text-secondary text-xs">{message}</p>
      </div>
    </div>
  );
}
