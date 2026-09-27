import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(webRoot, "../..");

export default defineConfig(({ command, mode }) => {
  // Vite defers its own .env loading until after this config is evaluated, so
  // the proxy target is read explicitly from the repository root rather than
  // from process.env. The "" prefix keeps K5_ keys out of the client bundle
  // while making them visible here.
  const fileEnv = loadEnv(mode, repoRoot, "");
  const serverOrigin = (
    process.env.K5_SERVER_ORIGIN ??
    fileEnv.K5_SERVER_ORIGIN ??
    ""
  )
    .trim()
    .replace(/\/+$/, "");

  // `vite build` emits a static artifact and needs no server, so a missing
  // target is a hard error only for serve/preview.
  const proxy =
    serverOrigin === "" && command !== "build"
      ? (() => {
          throw new Error(
            "K5_SERVER_ORIGIN is required for vite serve/preview, e.g. http://127.0.0.1:8787",
          );
        })()
      : serverOrigin === ""
        ? undefined
        : ({
            // Anchored so a sibling route like /apixyz is not swallowed.
            "^/api(?:/|$)": { target: serverOrigin, changeOrigin: true },
            // rewriteWsOrigin stays unset on purpose: rewriting would hide the
            // browser's real Origin from the gateway's allowlist and reopen
            // CSRF. changeOrigin only rewrites Host, never Origin.
            "^/ws(?:/|$)": { target: serverOrigin, ws: true, changeOrigin: true },
          } satisfies Record<string, ProxyOptions>);

  return {
    plugins: [react(), tailwindcss(), viteSingleFile()],
    resolve: {
      alias: {
        "@": path.resolve(webRoot, "src"),
      },
    },
    server: proxy === undefined ? undefined : { proxy },
  };
});
