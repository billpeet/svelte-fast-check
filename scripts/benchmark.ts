/**
 * Benchmark script to measure each step's time
 */
import { resolve } from "node:path";
import { collectAllSvelteWarnings } from "../src/compiler/collect";
import {
  type BackendName,
  isBackendName,
  runBackend,
} from "../src/typecheck/backends";
import {
  convertAllSvelteFiles,
  generateTsconfig,
} from "../src/typecheck/convert";
import type { FastCheckConfig } from "../src/types";

async function benchmark(projectPath: string, backend: BackendName) {
  const config: FastCheckConfig = {
    rootDir: resolve(projectPath),
    srcDir: "./src",
  };

  console.log(`\n📊 Benchmarking: ${projectPath} (backend: ${backend})\n`);
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

  // Step 3: type check
  const s3 = performance.now();
  await runBackend(backend, { rootDir: config.rootDir, tsconfigPath });
  const t3 = Math.round(performance.now() - s3);
  console.log(`${`${backend} type check:`.padEnd(23)}${t3}ms`);

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
  console.log(`  type check:  ${((t3 / total) * 100).toFixed(1)}%`);
  console.log(`  svelte warn: ${((t4 / total) * 100).toFixed(1)}%`);
}

// Run benchmark
// Usage: bun scripts/benchmark.ts <project path> [tsgo|bun]
const projectPath = process.argv[2] || "./benchmark/melting/melting";
const backendArg = process.argv[3] || "tsgo";
if (!isBackendName(backendArg)) {
  throw new Error(`Unknown backend "${backendArg}". Expected "tsgo" or "bun".`);
}
benchmark(projectPath, backendArg);
