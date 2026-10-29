// Builds the phone client into dist/renderer-mobile, which the remote server
// serves as static files (main/remote/ws-server.ts `handleHttp`). Separate from the
// desktop renderer config because it has a different entry, output dir, and browser
// target: a phone browser, not Electron's Chromium.
//
// Two entries: the app (bundle.js, loaded by index.html) and its service worker
// (sw.js, at the root so its scope is the whole app). Neither name carries a hash:
// the service worker lists the app's files by name, and the server serves every
// file `no-cache` so a new build is fetched as soon as it exists.

import { defineConfig } from "@rspack/cli";
import { rspack } from "@rspack/core";
import fs from "fs";
import path from "path";

const { version } = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "package.json"), "utf8")) as {
  version: string;
};
// Names the service worker's cache: every build gets its own, and the previous
// build's is deleted when the new worker takes over.
const swVersion = `${version}-${Date.now().toString(36)}`;

export default defineConfig({
  entry: {
    main: "./src/renderer-mobile/index.tsx",
    sw: { import: "./src/renderer-mobile/sw.ts", filename: "sw.js" },
  },
  output: {
    path: path.resolve(import.meta.dirname, "dist/renderer-mobile"),
    filename: "bundle.js",
    // Relative so the bundle loads regardless of which host the phone used.
    publicPath: "./",
  },
  resolve: {
    extensions: [".ts", ".tsx", ".js", ".jsx"],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: "builtin:swc-loader",
          options: {
            jsc: {
              parser: { syntax: "typescript", tsx: true },
              transform: { react: { runtime: "automatic" } },
            },
          },
        },
        exclude: /node_modules/,
      },
      {
        test: /\.css$/,
        use: ["style-loader", "css-loader"],
      },
    ],
  },
  plugins: [
    new rspack.HtmlRspackPlugin({
      template: "./src/renderer-mobile/index.html",
      chunks: ["main"],
    }),
    new rspack.DefinePlugin({
      __SW_VERSION__: JSON.stringify(swVersion),
    }),
    new rspack.CopyRspackPlugin({
      patterns: [
        { from: "src/renderer-mobile/manifest.webmanifest", to: "manifest.webmanifest" },
        { from: "src/renderer-mobile/icons", to: "icons" },
      ],
    }),
  ],
  // Phones lag desktop browsers, so don't emit syntax that a two-year-old
  // Safari can't parse.
  target: ["web", "es2020"],
});
