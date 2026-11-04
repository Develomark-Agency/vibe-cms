import "vibe-cms/panel/styles.css";
import { startPanel } from "vibe-cms/panel";
import { hostedBackend } from "./backend.ts";

startPanel(hostedBackend());
