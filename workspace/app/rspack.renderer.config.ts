import { defineConfig } from "@rspack/cli";
import { rspack } from "@rspack/core";
import path from "path";

export default defineConfig({
  entry: "./src/renderer/index.tsx",
  output: {
    path: path.resolve(import.meta.dirname, "dist/renderer"),
    filename: "bundle.js",
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
      template: "./src/renderer/index.html",
    }),
    new rspack.CopyRspackPlugin({
      patterns: [
        {
          from: "src/renderer/assets",
          to: "assets",
          noErrorOnMissing: true,
        },
      ],
    }),
  ],
  devServer: {
    port: 8080,
    hot: true,
  },
  target: "web",
});
