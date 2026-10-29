import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./index.css";
import "./lib/theme.ts";

// After a deploy, an open page may request lazy chunks that no longer exist.
window.addEventListener("vite:preloadError", () => location.reload());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
