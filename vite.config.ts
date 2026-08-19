import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { filmprintApi } from "./src/server/vite-plugin.ts";

export default defineConfig({
  root: "web",
  // The db path is relative to the repo root, not web/.
  plugins: [react(), filmprintApi("data/filmprint.db")],
  server: { port: 5273 },
  build: { outDir: "../dist/web", emptyOutDir: true },
});
