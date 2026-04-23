import { Tabs, TabsContent, TabsList, TabsTrigger } from "@autonoma/blacklight";
import {
  TestPlanView,
  TestStepsView,
} from "routes/_blacklight/_app-shell/app.$appSlug/edit/-test-suite/edit-test-detail";

interface ReadOnlyTestDetailProps {
  testCase: {
    name: string;
    plan: { prompt: string } | null;
    steps: { list: unknown } | null;
  };
}

export function ReadOnlyTestDetail({ testCase }: ReadOnlyTestDetailProps) {
  return (
    <div className="flex h-full flex-col overflow-y-auto p-6">
      <div className="mb-6">
        <h2 className="text-xl font-medium tracking-tight text-text-primary">{testCase.name}</h2>
      </div>

      <Tabs defaultValue="plan" className="flex min-h-0 flex-1 flex-col">
        <TabsList className="shrink-0">
          <TabsTrigger value="plan">Plan</TabsTrigger>
          <TabsTrigger value="steps">Steps</TabsTrigger>
        </TabsList>

        <TabsContent value="plan" className="mt-4 min-h-0 flex-1 overflow-y-auto">
          <TestPlanView plan={testCase.plan} />
        </TabsContent>

        <TabsContent value="steps" className="mt-4 min-h-0 flex-1 flex flex-col overflow-y-auto">
          <TestStepsView steps={testCase.steps} />
        </TabsContent>
      </Tabs>
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
