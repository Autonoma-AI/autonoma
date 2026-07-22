import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import DocsPage from "./docs-page.tsx";
import LogoPage from "./logo-page.tsx";
import Presentation from "./presentation.tsx";
import TelemetryPage from "./telemetry-page.tsx";

function Router() {
  const path = window.location.pathname;

  if (path === "/presentation") {
    return <Presentation />;
  }

  if (path === "/logo") {
    return <LogoPage />;
  }

  if (path === "/telemetry") {
    return <TelemetryPage />;
  }

  if (path === "/docs") {
    return <DocsPage />;
  }

  return <App />;
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
