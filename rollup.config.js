import typescript from "rollup-plugin-typescript2";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import fs from "fs";

const banner = () => ({
  name: "banner",
  generateBundle() {
    fs.copyFileSync("manifest.json", "dist/manifest.json");
  },
});

export default {
  input: "src/main.ts",
  output: {
    dir: "dist",
    format: "cjs",
    exports: "default",
  },
  external: ["obsidian"],
  plugins: [typescript(), nodeResolve(), commonjs(), banner()],
};