/**
 * Re-export so the existing `@autonoma/test-updates` importers keep their path.
 * The endpoint URL rules live in `@autonoma/types` (`sdk-endpoint.ts`), which has
 * no workspace dependencies and is therefore reachable from `@autonoma/scenario`
 * too - this package is not.
 */
export { DEFAULT_SDK_PATH, applySdkPath, buildSdkUrl } from "@autonoma/types";
