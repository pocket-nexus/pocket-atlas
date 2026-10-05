import { defineConfig } from "vite";
import { sourceSnapshot } from "./scripts/export-source";

export default defineConfig({
  plugins: [{
    name: "atlas-source-identity",
    configureServer(server) {
      server.middlewares.use("/__atlas/source", (_req, res) => {
        try {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ...sourceSnapshot(server.config.root), instance: process.env.ATLAS_EXPORT_SERVER_ID }));
        } catch (error) {
          res.statusCode = 500;
          res.end(String(error));
        }
      });
    },
  }],
  base: "./",
  // the Pocket3D title card is served from vendor/pocketjs, one level above this app
  server: { host: "127.0.0.1", port: 5173, fs: { allow: [".."] } },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
});
