/**
 * svelte2tsx conversion module
 *
 * Converts .svelte files to .svelte.tsx under .fast-check/tsx/.
 * Sourcemaps are stored in .fast-check/maps/ for incremental builds.
 * Uses Promise.all + async IO for parallel conversion.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { svelte2tsx } from "svelte2tsx";
import { glob } from "tinyglobby";
import ts from "typescript";
import type {
  ConversionResult,
  FastCheckConfig,
  SourceMapData,
} from "../types";

// Get svelte2tsx package path (from svelte-fast-check's own dependencies)
const require = createRequire(import.meta.url);
const svelte2tsxPath = dirname(require.resolve("svelte2tsx/package.json"));

/** .fast-check folder path (relative to project root) */
const DEFAULT_CACHE_ROOT = ".fast-check";
const TSX_DIR = "tsx";
const MAPS_DIR = "maps";

/** Module resolution strategies that need override to bundler */
const MODULE_RESOLUTIONS_NEEDING_OVERRIDE = ["nodenext", "node16"];

function getCacheRoot(config: FastCheckConfig): string {
  return config.cacheDir || DEFAULT_CACHE_ROOT;
}

/** Dynamic tsconfig path */
export const getGeneratedTsconfigPath = (config: FastCheckConfig): string =>
  resolve(config.rootDir, getCacheRoot(config), "tsconfig.json");

/**
 * Convert source path to cache path
 * src/routes/+layout.svelte -> .fast-check/tsx/src/routes/+layout.svelte.tsx
 */
function getTsxPath(config: FastCheckConfig, sourcePath: string): string {
  const relativePath = relative(config.rootDir, sourcePath);
  return resolve(
    config.rootDir,
    getCacheRoot(config),
    TSX_DIR,
    `${relativePath}.tsx`,
  );
}

/**
 * Convert source path to sourcemap cache path
 * src/routes/+layout.svelte -> .fast-check/maps/src_routes_+layout.svelte.map.json
 */
function getMapPath(config: FastCheckConfig, sourcePath: string): string {
  const relativePath = relative(config.rootDir, sourcePath);
  const safeName = relativePath.replace(/[/\\]/g, "_");
  return resolve(
    config.rootDir,
    getCacheRoot(config),
    MAPS_DIR,
    `${safeName}.map.json`,
  );
}

/**
 * Initialize cache directories
 */
export function ensureCacheDir(config: FastCheckConfig): void {
  const cacheRoot = getCacheRoot(config);
  const tsxDir = resolve(config.rootDir, cacheRoot, TSX_DIR);
  const mapsDir = resolve(config.rootDir, cacheRoot, MAPS_DIR);

  if (!existsSync(tsxDir)) {
    mkdirSync(tsxDir, { recursive: true });
  }
  if (!existsSync(mapsDir)) {
    mkdirSync(mapsDir, { recursive: true });
  }
}

/**
 * Find all .svelte files and convert to .svelte.tsx (parallel with Promise.all)
 */
export async function convertAllSvelteFiles(
  config: FastCheckConfig,
): Promise<ConversionResult[]> {
  ensureCacheDir(config);

  const files = await findSvelteFiles(config);
  console.log(`Found ${files.length} .svelte files`);

  // Parallel conversion with async IO via Promise.all
  const results = await Promise.all(
    files.map((file) => {
      const sourcePath = resolve(config.rootDir, file);
      return convertSvelteFileAsync(config, sourcePath);
    }),
  );

  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  console.log(`Converted ${successCount} files successfully`);
  if (failCount > 0) {
    console.log(`Failed to convert ${failCount} files`);
  }

  return results;
}

/**
 * Convert a single .svelte file to .svelte.tsx (async)
 */
async function convertSvelteFileAsync(
  config: FastCheckConfig,
  sourcePath: string,
): Promise<ConversionResult> {
  const outputPath = getTsxPath(config, sourcePath);
  const mapPath = getMapPath(config, sourcePath);

  try {
    const content = await readFile(sourcePath, "utf-8");
    const hasTs =
      content.includes('lang="ts"') || content.includes("lang='ts'");

    const result = svelte2tsx(content, {
      filename: sourcePath,
      isTsFile: hasTs,
      mode: "ts",
    });

    // Create output directory (ignore EEXIST for race condition with Promise.all)
    const outputDir = dirname(outputPath);
    await mkdir(outputDir, { recursive: true }).catch(() => {});

    // Save .svelte.tsx file and sourcemap in parallel
    await Promise.all([
      writeFile(outputPath, result.code),
      writeFile(mapPath, JSON.stringify(result.map)),
    ]);

    return {
      sourcePath,
      outputPath,
      map: result.map,
      success: true,
    };
  } catch (e: unknown) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`Error converting ${sourcePath}: ${error}`);
    return {
      sourcePath,
      outputPath,
      map: { mappings: "", sources: [] as never[] },
      success: false,
      error,
    };
  }
}

/**
 * Load sourcemap (async)
 */
async function loadSourcemap(mapPath: string): Promise<SourceMapData | null> {
  if (!existsSync(mapPath)) {
    return null;
  }

  try {
    const content = await readFile(mapPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Convert only changed files (mtime-based, parallel) + delete orphan tsx files
 */
export async function convertChangedFiles(
  config: FastCheckConfig,
): Promise<ConversionResult[]> {
  ensureCacheDir(config);

  const files = await findSvelteFiles(config);
  const validTsxPaths = new Set<string>();

  // Classify files that need conversion vs files to skip
  const toConvert: string[] = [];
  const skippedFiles: Array<{
    sourcePath: string;
    outputPath: string;
    mapPath: string;
  }> = [];

  for (const file of files) {
    const sourcePath = resolve(config.rootDir, file);
    const outputPath = getTsxPath(config, sourcePath);
    const mapPath = getMapPath(config, sourcePath);

    validTsxPaths.add(outputPath);

    // Skip if output file exists and is newer than source
    if (existsSync(outputPath) && existsSync(mapPath)) {
      const sourceStat = statSync(sourcePath);
      const outputStat = statSync(outputPath);

      if (outputStat.mtime >= sourceStat.mtime) {
        skippedFiles.push({ sourcePath, outputPath, mapPath });
        continue;
      }
    }

    toConvert.push(sourcePath);
  }

  // Load sourcemaps for skipped files in parallel
  const skippedResults = await Promise.all(
    skippedFiles.map(async ({ sourcePath, outputPath, mapPath }) => {
      const map = await loadSourcemap(mapPath);
      return {
        sourcePath,
        outputPath,
        map: map || { mappings: "", sources: [] as never[] },
        success: !!map,
      };
    }),
  );

  // Convert only changed files in parallel with Promise.all
  const convertedResults = await Promise.all(
    toConvert.map((sourcePath) => convertSvelteFileAsync(config, sourcePath)),
  );

  const results = [...skippedResults, ...convertedResults];

  // Delete orphan tsx files (when source has been deleted)
  const orphansDeleted = await cleanOrphanTsxFiles(config, validTsxPaths);

  const converted = convertedResults.filter((r) => r.success).length;
  const skipped = skippedResults.length;
  let message = `Converted ${converted} files, skipped ${skipped} unchanged`;
  if (orphansDeleted > 0) {
    message += `, deleted ${orphansDeleted} orphans`;
  }
  console.log(message);

  return results;
}

/**
 * Delete orphan tsx files whose source has been deleted
 */
async function cleanOrphanTsxFiles(
  config: FastCheckConfig,
  validTsxPaths: Set<string>,
): Promise<number> {
  const cacheRoot = getCacheRoot(config);
  const tsxDir = resolve(config.rootDir, cacheRoot, TSX_DIR);
  if (!existsSync(tsxDir)) return 0;

  const existingTsxFiles = await glob("**/*.svelte.tsx", { cwd: tsxDir });
  let deleted = 0;

  for (const file of existingTsxFiles) {
    const tsxPath = resolve(tsxDir, file);
    if (!validTsxPaths.has(tsxPath)) {
      // Delete orphan tsx with no source
      try {
        unlinkSync(tsxPath);

        // Also delete corresponding sourcemap
        const relativePath = file.replace(/\.tsx$/, "");
        const safeName = relativePath.replace(/[/\\]/g, "_");
        const mapPath = resolve(
          config.rootDir,
          cacheRoot,
          MAPS_DIR,
          `${safeName}.map.json`,
        );
        if (existsSync(mapPath)) {
          unlinkSync(mapPath);
        }

        deleted++;
      } catch {
        // Ignore deletion failures
      }
    }
  }

  return deleted;
}

/**
 * Return all sourcemaps as a Map
 */
export function buildSourcemapMap(
  results: ConversionResult[],
): Map<string, SourceMapData> {
  const maps = new Map<string, SourceMapData>();

  for (const result of results) {
    if (result.success && result.map) {
      maps.set(result.outputPath, result.map);
    }
  }

  return maps;
}

export interface GenerateTsconfigOptions {
  /** Whether to use incremental build (default: true) */
  incremental?: boolean;
}

/**
 * Generate .fast-check/tsconfig.json for tsgo
 *
 * Why we don't use "extends" in generated tsconfig:
 * - tsgo has compatibility issues with some tsconfig options (rootDirs, certain path resolutions)
 * - Instead, we read the project's tsconfig.json (following extends chain), merge settings,
 *   and generate a standalone tsconfig with only the options tsgo supports well
 *
 * Reads the project's tsconfig.json as a base,
 * and overrides only the settings required by fast-check.
 */
export async function generateTsconfig(
  config: FastCheckConfig,
  options: GenerateTsconfigOptions = {},
): Promise<string> {
  const { incremental = false } = options;
  const tsconfigPath = getGeneratedTsconfigPath(config);

  // Read project tsconfig.json (following extends chain to .svelte-kit/tsconfig.json)
  const projectTsconfig = readTypesFromTsconfig(config.rootDir);

  // Check if this is a SvelteKit project
  const isSvelteKit = existsSync(resolve(config.rootDir, ".svelte-kit"));

  // Read paths from tsconfig.json, use SvelteKit defaults if not present.
  // They were made absolute while reading, so re-express them relative to the
  // generated tsconfig's directory.
  const generatedDir = dirname(tsconfigPath);
  const relativizeAll = (absolutePaths: string[]) =>
    absolutePaths.map((p) => toTsconfigRelative(generatedDir, p));
  const tsconfigPaths = Object.fromEntries(
    Object.entries(
      (projectTsconfig?.compilerOptions?.paths as Record<string, string[]>) ||
        {},
    ).map(([alias, targets]) => [alias, relativizeAll(targets)]),
  );
  const typeRoots = projectTsconfig?.compilerOptions?.typeRoots as
    | string[]
    | undefined;
  const defaultPaths: Record<string, string[]> = isSvelteKit
    ? {
        $lib: ["./../src/lib"],
        "$lib/*": ["./../src/lib/*"],
      }
    : {};
  // Priority: config.paths > tsconfig paths > defaults
  const paths = {
    ...defaultPaths,
    ...tsconfigPaths,
    ...config.paths,
  };

  // NodeNext/Node16 doesn't resolve .svelte to .svelte.tsx, causing false negatives.
  // Override to bundler resolution which handles this correctly.
  // See: https://github.com/astralhpi/svelte-fast-check/issues/5
  const moduleResolution = projectTsconfig?.compilerOptions?.moduleResolution;
  const needsModuleResolutionOverride =
    typeof moduleResolution === "string" &&
    MODULE_RESOLUTIONS_NEEDING_OVERRIDE.includes(
      moduleResolution.toLowerCase(),
    );

  // Generate tsconfig for fast-check
  // Override only necessary settings on top of project tsconfig's compilerOptions
  const tsconfigContent = {
    compilerOptions: {
      // Settings inherited from project tsconfig
      ...projectTsconfig?.compilerOptions,

      // Settings forced by fast-check (overrides)
      noEmit: true,
      skipLibCheck: true,
      jsx: "preserve",
      jsxImportSource: "svelte",

      ...(needsModuleResolutionOverride
        ? { moduleResolution: "bundler", module: "esnext" }
        : {}),

      // Incremental build settings
      incremental,
      tsBuildInfoFile: incremental ? "./.tsbuildinfo" : undefined,

      // rootDirs: merge tsx folder with project root
      rootDirs: isSvelteKit
        ? ["..", "../.svelte-kit/types", "./tsx"]
        : ["..", "./tsx"],

      // paths need to be converted to relative paths
      paths,
      ...(typeRoots ? { typeRoots: relativizeAll(typeRoots) } : {}),

      // Use defaults if lib is not specified
      lib: projectTsconfig?.compilerOptions?.lib || [
        "esnext",
        "DOM",
        "DOM.Iterable",
      ],

      // Use project's types if specified, otherwise use config.types
      // This ensures @types/* packages are properly loaded
      types:
        config.types ??
        (projectTsconfig?.compilerOptions?.types as string[] | undefined),
    },

    // svelte2tsx shims + app.d.ts for DOM type overrides
    // Use absolute paths to svelte2tsx from svelte-fast-check's dependencies
    files: [
      // SvelteKit app.d.ts for global type declarations
      ...(isSvelteKit ? ["../src/app.d.ts"] : []),
      resolve(svelte2tsxPath, "svelte-shims-v4.d.ts"),
      resolve(svelte2tsxPath, "svelte-jsx-v4.d.ts"),
    ],

    include: [
      // SvelteKit generated types
      ...(isSvelteKit
        ? [
            "../.svelte-kit/ambient.d.ts",
            "../.svelte-kit/non-ambient.d.ts",
            "../.svelte-kit/types/**/$types.d.ts",
          ]
        : []),
      "../src/**/*.ts",
      "../src/**/*.d.ts",
      "./tsx/**/*.svelte.tsx",
      ...(config.include || []),
    ],

    exclude: [
      "../node_modules/**",
      // Include excludes from tsconfig.json
      ...(projectTsconfig?.exclude || []).map((p: string) => `../${p}`),
      ...(config.exclude || []).map((p: string) =>
        p.startsWith("../") ? p : `../${p}`,
      ),
    ],
  };

  await writeFile(tsconfigPath, JSON.stringify(tsconfigContent, null, 2));
  return tsconfigPath;
}

/** Parsed tsconfig structure */
interface ParsedTsconfig {
  compilerOptions?: Record<string, unknown>;
  include?: string[];
  exclude?: string[];
}

/**
 * Resolve patterns from a tsconfig relative to rootDir.
 * Converts patterns like "../src/**\/*.svelte" (relative to .svelte-kit/)
 * to "src/**\/*.svelte" (relative to rootDir).
 */
function resolvePatterns(
  patterns: string[] | undefined,
  patternBaseDir: string,
  rootDir: string,
): string[] | undefined {
  if (!patterns) return undefined;

  return patterns.map((pattern) => {
    // All non-absolute paths in tsconfig are relative to the file's directory.
    // Resolve to absolute path, then make relative to rootDir for glob.
    const absolutePath = resolve(patternBaseDir, pattern);
    // Use forward slashes for glob patterns (Windows returns backslashes)
    return relative(rootDir, absolutePath).replace(/\\/g, "/");
  });
}

/**
 * Parse a tsconfig file. tsconfig files are JSONC (comments and trailing
 * commas are allowed), so they are parsed with TypeScript's own reader.
 */
function parseTsconfigFile(
  tsconfigPath: string,
): Record<string, unknown> | null {
  try {
    const content = readFileSync(tsconfigPath, "utf-8");
    const { config } = ts.parseConfigFileTextToJson(tsconfigPath, content);
    return config && typeof config === "object" ? config : null;
  } catch {
    return null;
  }
}

/** First candidate that exists as a file, or null */
function firstExistingFile(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not found, try the next candidate
    }
  }
  return null;
}

/**
 * Resolve a tsconfig `extends` specifier to an absolute file path.
 *
 * Follows TypeScript's rules:
 * - relative or absolute paths resolve against the extending file, with an
 *   optional `.json` extension
 * - anything else is looked up in `node_modules`, walking up from the
 *   extending file (e.g. `@tsconfig/svelte`, or SvelteKit 3's `$app/tsconfig`)
 */
export function resolveExtendsPath(
  specifier: string,
  fromDir: string,
): string | null {
  const candidatesFor = (base: string) =>
    base.endsWith(".json")
      ? [base]
      : [`${base}.json`, resolve(base, "tsconfig.json"), base];

  if (/^\.\.?([/\\]|$)/.test(specifier) || isAbsolute(specifier)) {
    return firstExistingFile(candidatesFor(resolve(fromDir, specifier)));
  }

  let dir = fromDir;
  while (true) {
    const found = firstExistingFile(
      candidatesFor(resolve(dir, "node_modules", specifier)),
    );
    if (found) return found;

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Make path-valued compiler options absolute, so they keep their meaning when
 * merged into a tsconfig that lives in a different directory.
 * `paths` are relative to `baseUrl` if set, otherwise to the tsconfig's directory.
 */
function absolutizeCompilerOptions(
  compilerOptions: Record<string, unknown> | undefined,
  tsconfigDir: string,
): Record<string, unknown> | undefined {
  if (!compilerOptions) return undefined;
  const result = { ...compilerOptions };

  if (result.paths && typeof result.paths === "object") {
    const pathsBase =
      typeof result.baseUrl === "string"
        ? resolve(tsconfigDir, result.baseUrl)
        : tsconfigDir;
    result.paths = Object.fromEntries(
      Object.entries(result.paths as Record<string, string[]>).map(
        ([alias, targets]) => [
          alias,
          targets.map((target) => resolve(pathsBase, target)),
        ],
      ),
    );
  }

  if (Array.isArray(result.typeRoots)) {
    result.typeRoots = (result.typeRoots as string[]).map((typeRoot) =>
      resolve(tsconfigDir, typeRoot),
    );
  }

  return result;
}

/** Express an absolute path relative to a directory, in tsconfig form */
function toTsconfigRelative(fromDir: string, absolutePath: string): string {
  const relativePath = relative(fromDir, absolutePath).replace(/\\/g, "/");
  if (isAbsolute(relativePath)) return relativePath; // different drive
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

/**
 * Read project tsconfig.json, following its `extends` chain.
 *
 * - include/exclude patterns are resolved relative to rootDir
 * - `paths` and `typeRoots` are returned as absolute paths
 */
export function readTypesFromTsconfig(
  rootDir: string,
  tsconfigFileName: string = "tsconfig.json",
  tsconfigDir?: string,
): ParsedTsconfig | null {
  return loadTsconfig(
    resolve(tsconfigDir || rootDir, tsconfigFileName),
    rootDir,
    new Set(),
  );
}

/** Unresolved `extends` already warned about (the tsconfig is read more than once per run) */
const warnedExtends = new Set<string>();

function loadTsconfig(
  tsconfigPath: string,
  rootDir: string,
  seen: Set<string>,
): ParsedTsconfig | null {
  // Guard against circular extends
  if (seen.has(tsconfigPath)) return null;
  seen.add(tsconfigPath);

  if (!existsSync(tsconfigPath)) return null;
  const tsconfig = parseTsconfigFile(tsconfigPath);
  if (!tsconfig) return null;

  const currentDir = dirname(tsconfigPath);

  // `extends` may be a string or an array; later entries override earlier ones
  const extendsList = (
    Array.isArray(tsconfig.extends) ? tsconfig.extends : [tsconfig.extends]
  ).filter((entry): entry is string => typeof entry === "string");

  let merged: ParsedTsconfig = {};
  for (const specifier of extendsList) {
    const parentPath = resolveExtendsPath(specifier, currentDir);
    const parent = parentPath ? loadTsconfig(parentPath, rootDir, seen) : null;
    if (!parent) {
      const warningKey = `${tsconfigPath}::${specifier}`;
      if (warnedExtends.has(warningKey)) continue;
      warnedExtends.add(warningKey);
      console.warn(
        `[svelte-fast-check] Warning: Could not resolve "extends": "${specifier}" in ${tsconfigPath}. Its settings will be ignored.`,
      );
      continue;
    }
    merged = {
      compilerOptions: { ...merged.compilerOptions, ...parent.compilerOptions },
      include: parent.include || merged.include,
      exclude: parent.exclude || merged.exclude,
    };
  }

  const ownCompilerOptions = absolutizeCompilerOptions(
    tsconfig.compilerOptions as Record<string, unknown> | undefined,
    currentDir,
  );
  const compilerOptions =
    merged.compilerOptions || ownCompilerOptions
      ? { ...merged.compilerOptions, ...ownCompilerOptions }
      : undefined;

  return {
    compilerOptions,
    // Own patterns replace inherited ones (which are already resolved)
    include:
      resolvePatterns(
        tsconfig.include as string[] | undefined,
        currentDir,
        rootDir,
      ) || merged.include,
    exclude:
      resolvePatterns(
        tsconfig.exclude as string[] | undefined,
        currentDir,
        rootDir,
      ) || merged.exclude,
  };
}

/**
 * Find all svelte files based on tsconfig include patterns.
 * Reads include patterns from tsconfig.json and falls back to src/**\/*.svelte.
 */
export async function findSvelteFiles(
  config: FastCheckConfig,
): Promise<string[]> {
  const tsconfig = readTypesFromTsconfig(config.rootDir);

  // Extract *.svelte patterns from tsconfig, or use default
  // Use regex to match patterns ending with .svelte (e.g., **/*.svelte)
  // This avoids matching .svelte-kit paths
  let patterns = ["src/**/*.svelte"];
  if (tsconfig?.include) {
    const sveltePatterns = tsconfig.include.filter((pattern) =>
      /\.svelte$/.test(pattern),
    );
    if (sveltePatterns.length > 0) {
      patterns = sveltePatterns;
    }
  }

  const exclude = tsconfig?.exclude || [];

  // Use tinyglobby for cross-platform glob support
  const files = await glob(patterns, {
    cwd: config.rootDir,
    ignore: [...exclude, "**/node_modules/**"],
  });

  return [...new Set(files)];
}
