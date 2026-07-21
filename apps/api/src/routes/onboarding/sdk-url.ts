// The SDK/preview-webhook URL convention lives in @autonoma/test-updates so the
// API and the diffs-worker activity derive it identically. Re-exported here to
// keep existing onboarding/vercel import sites stable.
export { buildSdkUrl } from "@autonoma/test-updates";
