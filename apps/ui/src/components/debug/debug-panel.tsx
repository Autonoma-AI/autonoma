import {
  AuthenticationSection,
  ConversationSection,
  EnvironmentSection,
  ScenarioSetupSection,
  VariablesSection,
  WebhookCallsSection,
} from "./sections";
import type { DebugData } from "./types";

interface DebugPanelProps {
  debug: DebugData;
  conversationUrl?: string;
}

export function DebugPanel({ debug, conversationUrl }: DebugPanelProps) {
  const { scenarioInstance, deploymentUrl, scenarioName, snapshot, webhookCalls } = debug;

  return (
    <div className="space-y-3">
      <EnvironmentSection deploymentUrl={deploymentUrl} scenarioName={scenarioName} snapshot={snapshot} />
      {scenarioInstance?.auth != null && <AuthenticationSection auth={scenarioInstance.auth} />}
      {scenarioInstance?.resolvedVariables != null && (
        <VariablesSection variables={scenarioInstance.resolvedVariables} />
      )}
      {scenarioInstance != null && <ScenarioSetupSection instance={scenarioInstance} />}
      <WebhookCallsSection calls={webhookCalls} />
      {conversationUrl != null && <ConversationSection url={conversationUrl} />}
    </div>
  );
}
