/**
 * Benchmark script to measure each step's time
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { collectAllSvelteWarnings } from "../src/compiler/collect";
import {
  convertAllSvelteFiles,
  generateTsconfig,
} from "../src/typecheck/convert";
import type { FastCheckConfig } from "../src/types";

const require = createRequire(import.meta.url);

function getTsgoPath(): string {
  const packageJsonPath = require.resolve("typescript7/package.json");
  return join(dirname(packageJsonPath), "bin", "tsc");
}

async function benchmark(projectPath: string) {
  const config: FastCheckConfig = {
    rootDir: resolve(projectPath),
    srcDir: "./src",
  };

  console.log(`\n📊 Benchmarking: ${projectPath}\n`);
  console.log("─".repeat(50));

  // Step 1: svelte2tsx conversion
  const s1 = performance.now();
  const results = await convertAllSvelteFiles(config);
  const t1 = Math.round(performance.now() - s1);
  console.log(`svelte2tsx conversion: ${t1}ms (${results.length} files)`);

  // Step 2: Generate tsconfig
  const s2 = performance.now();
  const tsconfigPath = await generateTsconfig(config, { incremental: false });
  const t2 = Math.round(performance.now() - s2);
  console.log(`Generate tsconfig:     ${t2}ms`);

  // Step 3: tsgo type check
  const tsgoPath = getTsgoPath();
  const s3 = performance.now();
  spawnSync("node", [tsgoPath, "--noEmit", "-p", tsconfigPath], {
    cwd: config.rootDir,
    encoding: "utf-8",
  });
  const t3 = Math.round(performance.now() - s3);
  console.log(`tsgo type check:       ${t3}ms`);

  // Step 4: Svelte compiler warnings
  const s4 = performance.now();
  const warnings = await collectAllSvelteWarnings(config);
  const t4 = Math.round(performance.now() - s4);
  console.log(`Svelte warnings:       ${t4}ms (${warnings.length} warnings)`);

  console.log("─".repeat(50));
  const total = t1 + t2 + t3 + t4;
  console.log(`Total:                 ${total}ms`);
  console.log();
  console.log("Breakdown:");
  console.log(`  svelte2tsx:  ${((t1 / total) * 100).toFixed(1)}%`);
  console.log(`  tsconfig:    ${((t2 / total) * 100).toFixed(1)}%`);
  console.log(`  tsgo:        ${((t3 / total) * 100).toFixed(1)}%`);
  console.log(`  svelte warn: ${((t4 / total) * 100).toFixed(1)}%`);
}

// Run benchmark
const projectPath = process.argv[2] || "./benchmark/melting/melting";
benchmark(projectPath);
