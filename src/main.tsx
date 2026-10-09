/*
  The browser entry: fonts, tokens, and the React root.
  In the app: the one script index.html loads.
  Used by: index.html.
  Uses: self-hosted font files from node_modules (bundled by Vite, so the CSP needs no outside host).
*/
// oxlint-disable import/no-unassigned-import -- CSS and font files register by being imported
import "@fontsource-variable/bodoni-moda/opsz.css";
import "@fontsource-variable/bodoni-moda/opsz-italic.css";
import "@fontsource-variable/libre-franklin/wght.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@/shared/ui/tokens.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/app/App";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
