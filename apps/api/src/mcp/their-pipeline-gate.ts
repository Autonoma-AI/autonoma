import { BadRequestError } from "@autonoma/errors";
import { isVercelPath, type VercelState } from "./vercel-onboarding-guidance";

/**
 * Whether this app may use the customer's own pipeline, and what to do first when
 * it may not.
 *
 * The one rule the server enforces is that the USER chose it. Their own previews
 * can be the right answer anywhere - the onboarding questionnaire routes a custom
 * signed webhook exactly as it routes Vercel - but it is never something to infer
 * from a repo. A deploy workflow cannot tell you whether those previews work,
 * which database they point at, or whether the customer wants test data written
 * into it, and Autonoma builds nothing and keeps no logs on that path, so being
 * wrong is expensive and invisible.
 *
 * Whether an agent may RAISE the option is a different question, and one only the
 * agent is placed to answer, so it lives in the guidance rather than here: on
 * Vercel it may offer, because the integration makes it a genuine choice; off
 * Vercel it should say nothing and let the user bring it up. Both end at the same
 * place - the user's answer, quoted back.
 */
export function assertTheirPipelineIsAllowed(vercel: VercelState, userRequest: string | undefined): void {
    if (userRequest != null) return;

    if (isVercelPath(vercel)) {
        throw new BadRequestError(
            "This app is on Vercel, so its own previews are a real option - but it is the user's call, not " +
                "yours. It suits a project whose previews are entirely Vercel's: the backend in the same " +
                "deployable unit, and either data that is cleanly tenant-scoped or a branchable database " +
                "(Neon, Supabase, PlanetScale) giving each preview its own. Anything else - a backend deployed " +
                "elsewhere, global tables a teardown would leak into - should be `autonoma-hosted`, which plenty " +
                "of Vercel projects choose deliberately. Ask which fits, then call this again with `userRequest` " +
                "set to their answer.",
        );
    }

    throw new BadRequestError(
        "Pick `autonoma-hosted` and do not offer this instead. Off Vercel, wiring their own previews means the " +
            "project hand-writes a signed webhook, and Autonoma then builds nothing, verifies nothing and keeps " +
            "no logs for that preview - so it is worth doing only when the user asks for it themselves. If they " +
            "do ask, explain both sides first (their previews: less to change, but test data lands in whatever " +
            "database those previews point at, and a failure has no logs here; Autonoma-hosted: we build it, and " +
            "each preview gets its own database), get their answer, and call this again with `userRequest` set to " +
            "it. Do not raise it unprompted.",
    );
}
