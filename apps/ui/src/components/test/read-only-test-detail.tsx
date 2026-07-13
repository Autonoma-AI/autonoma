import { TestPlanView } from "routes/_blacklight/_app-shell/app.$appSlug/edit/-test-suite/edit-test-detail";

interface ReadOnlyTestDetailProps {
  testCase: {
    name: string;
    plan: { prompt: string } | null;
  };
}

export function ReadOnlyTestDetail({ testCase }: ReadOnlyTestDetailProps) {
  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-6">
        <h2 className="text-xl font-medium tracking-tight text-text-primary">{testCase.name}</h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <TestPlanView plan={testCase.plan} />
      </div>
    </div>
  );
}

export function ReadOnlyTestDetailEmpty() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-text-tertiary">
      <p className="text-sm">Select a test to view details</p>
    </div>
  );
}
