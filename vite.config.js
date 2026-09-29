import process from "node:process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import zbrainInspector from "./plugins/zbrain-inspector.mjs";

// The dev-server port and the API's port are both allocated at start-up, so they come
// from the environment instead of being fixed here.
export default defineConfig({
  plugins: [react(), zbrainInspector()],
  server: {
    host: true,
    port: Number(process.env.PORT || 5173),
    allowedHosts: [".zbrain.ai", "localhost"],
    proxy: {
      "/api": process.env.BACKEND_1_URL || "http://localhost:3000"
    }
  }
});
