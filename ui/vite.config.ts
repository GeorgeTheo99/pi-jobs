import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Builds use relative asset URLs, resolved against the <base href> the server injects.
export default defineConfig(({ command }) => ({
  base: command === "build" ? "./" : "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/api": process.env.VITE_DEV_PROXY ?? "http://127.0.0.1:8790",
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
}));
