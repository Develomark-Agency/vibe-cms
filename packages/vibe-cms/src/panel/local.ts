import "./styles.css";
import { localBackend } from "./backend.ts";
import { startPanel } from "./app.tsx";

// `vibe-cms admin --name … --accent … --icon …`, injected by the CLI.
declare const __VIBE_PANEL_BRANDING__: Record<string, string | undefined> | undefined;

startPanel(localBackend(typeof __VIBE_PANEL_BRANDING__ === "undefined" ? {} : __VIBE_PANEL_BRANDING__));
