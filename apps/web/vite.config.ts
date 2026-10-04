import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.WORKBENCH_DEV_API ?? "http://127.0.0.1:4310";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: api, ws: true, changeOrigin: false },
      "/preview": { target: api, ws: true, changeOrigin: false },
    },
  },
  build: { target: "es2022", sourcemap: true },
});
