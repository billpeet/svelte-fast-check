/**
 * TypeCheck Worker
 *
 * Pipeline: svelte2tsx -> type checker (tsgo or bun check) -> filter -> map
 */

import { relative, resolve } from "node:path";
import { parentPort } from "node:worker_threads";
import picomatch from "picomatch";
import type {
  Diagnostic,
  FastCheckConfig,
  MappedDiagnostic,
  WorkerOutput,
} from "../types";
import {
  type BackendName,
  backendSupportsIncremental,
  DEFAULT_BACKEND,
  runBackend,
} from "./backends";
import {
  buildSourcemapMap,
  convertAllSvelteFiles,
  convertChangedFiles,
  generateTsconfig,
} from "./convert";
import {
  extractTsxFiles,
  filterFalsePositives,
  loadTsxContents,
} from "./filter";
import { filterNegativeLines, mapDiagnostics } from "./mapper";
import { parseTscOutput } from "./parser";

/**
 * Filter out diagnostics from excluded file paths.
 *
 * tsconfig `exclude` only prevents files from being directly included by
 * `include` globs — it does not prevent type-checking of files reached via
 * imports. This post-processing step drops diagnostics whose resolved file
 * path matches any `config.exclude` pattern, ensuring excluded files are
 * truly silenced.
 */
export function filterExcludedPaths(
  diagnostics: MappedDiagnostic[],
  excludePatterns: string[],
): MappedDiagnostic[] {
  if (excludePatterns.length === 0) return diagnostics;
  const isExcluded = picomatch(excludePatterns);
  return diagnostics.filter((d) => !isExcluded(d.originalFile));
}

/** TypeCheck worker input */
export interface TypeCheckInput {
  config: FastCheckConfig;
  incremental: boolean;
  raw: boolean;
  /** Type checker to use (default: tsgo) */
  backend?: BackendName;
}

/** TypeCheck worker output */
export type TypeCheckOutput = WorkerOutput;

/**
 * Diagnostics reported against the generated tsconfig itself (for example a
 * compiler option the type checker has removed). When the checker hits one of
 * these it may stop before checking any source file, so they are surfaced as
 * a failure instead of being listed next to ordinary type errors.
 */
export function findTsconfigErrors(
  diagnostics: Diagnostic[],
  rootDir: string,
  tsconfigPath: string,
): Diagnostic[] {
  return diagnostics.filter(
    (d) => relative(resolve(rootDir, d.file), tsconfigPath) === "",
  );
}

async function run(input: TypeCheckInput): Promise<TypeCheckOutput> {
  const { config, incremental, raw } = input;
  const backend = input.backend ?? DEFAULT_BACKEND;
  const startTime = performance.now();

  try {
    // Step 1: svelte2tsx conversion
    const results = incremental
      ? await convertChangedFiles(config)
      : await convertAllSvelteFiles(config);

    // Step 2: Generate tsconfig & run the type checker
    const tsconfigPath = await generateTsconfig(config, {
      incremental: incremental && backendSupportsIncremental(backend),
    });
    const output = await runBackend(backend, {
      rootDir: config.rootDir,
      tsconfigPath,
      bunPath: config.bunPath,
    });

    // Step 3: Parse results
    let diagnostics = parseTscOutput(output);
    diagnostics = diagnostics.map((d) => ({ ...d, source: "ts" as const }));

    // Raw mode: skip filter/map, return the type checker's output as-is
    if (raw) {
      return {
        diagnostics: diagnostics.map((d) => ({
          ...d,
          originalFile: d.file,
          originalLine: d.line,
          originalColumn: d.column,
        })),
        duration: Math.round(performance.now() - startTime),
      };
    }

    // A rejected tsconfig means little or nothing was actually checked
    const tsconfigErrors = findTsconfigErrors(
      diagnostics,
      config.rootDir,
      tsconfigPath,
    );
    if (tsconfigErrors.length > 0) {
      const details = tsconfigErrors
        .map((d) => `  TS${d.code}: ${d.message}`)
        .join("\n");
      throw new Error(
        `The type checker (${backend}) rejected the generated tsconfig (${tsconfigPath}):\n${details}`,
      );
    }

    // Step 4: Filter false positives
    const tsxFiles = extractTsxFiles(diagnostics);
    const tsxContents = loadTsxContents(tsxFiles, config.rootDir);
    diagnostics = filterFalsePositives(diagnostics, tsxContents);

    // Step 5: Sourcemap mapping
    const sourcemaps = buildSourcemapMap(results);
    const cacheDir = config.cacheDir || ".fast-check";
    let mapped = mapDiagnostics(
      diagnostics,
      sourcemaps,
      config.rootDir,
      tsxContents,
      cacheDir,
    );
    mapped = filterNegativeLines(mapped);

    // Step 6: Filter diagnostics from excluded paths
    mapped = filterExcludedPaths(mapped, config.exclude || []);

    return {
      diagnostics: mapped,
      duration: Math.round(performance.now() - startTime),
    };
  } catch (e) {
    return {
      diagnostics: [],
      duration: Math.round(performance.now() - startTime),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// Worker message handler
parentPort?.on("message", async (input: TypeCheckInput) => {
  const result = await run(input);
  parentPort?.postMessage(result);
});
