import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, the API runs on :8080 and Vite proxies /api to it so the session cookie is same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/readyz": "http://localhost:8080",
    },
  },
});
