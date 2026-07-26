// Builds the phone client into dist/renderer-mobile, which the remote server
// serves as static files on port 6768. Separate from the desktop renderer config
// because it has a different entry, output dir, and browser target — a phone
// browser, not Electron's Chromium.

import { defineConfig } from "@rspack/cli";
import { rspack } from "@rspack/core";
import path from "path";

export default defineConfig({
  entry: "./src/renderer-mobile/index.tsx",
  output: {
    path: path.resolve(import.meta.dirname, "dist/renderer-mobile"),
    filename: "bundle.js",
    // Relative so the bundle loads regardless of which host/IP the phone used.
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
    }),
    new rspack.CopyRspackPlugin({
      patterns: [
        {
          from: "src/renderer-mobile/manifest.webmanifest",
          to: "manifest.webmanifest",
        },
      ],
    }),
  ],
  // Phones lag desktop browsers, so don't emit syntax that a two-year-old
  // Safari can't parse.
  target: ["web", "es2020"],
});
