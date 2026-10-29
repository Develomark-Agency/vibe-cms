import "./styles.css";
import { localBackend } from "./backend.ts";
import { startPanel } from "./app.tsx";

startPanel(localBackend());
