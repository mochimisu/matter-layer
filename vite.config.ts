import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vite";

const apiPort = process.env.MATTER_LAYER_PORT ?? "3000";
const allowedHosts = process.env.MATTER_LAYER_ALLOWED_HOSTS
  ? process.env.MATTER_LAYER_ALLOWED_HOSTS.split(",").map((host) => host.trim()).filter(Boolean)
  : true;

export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  root: "web",
  test: {
    include: ["../test/**/*.test.ts"],
    environment: "node",
  },
  server: {
    allowedHosts,
    port: 5173,
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/events": {
        target: `ws://127.0.0.1:${apiPort}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
});
