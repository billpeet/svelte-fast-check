/**
 * Unit tests for type checker backend selection and invocation
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  BUN_PATH_ENV,
  backendSupportsIncremental,
  getBunCheckInvocation,
  getBunPath,
  isBackendName,
} from "../../src/typecheck/backends";
import { generateTsconfig } from "../../src/typecheck/convert";
import { findTsconfigErrors } from "../../src/typecheck/worker";
import type { Diagnostic } from "../../src/types";

describe("isBackendName", () => {
  test("accepts the known backends only", () => {
    expect(isBackendName("tsgo")).toBe(true);
    expect(isBackendName("bun")).toBe(true);
    expect(isBackendName("tsc")).toBe(false);
    expect(isBackendName(undefined)).toBe(false);
  });
});

describe("backendSupportsIncremental", () => {
  test("only tsgo keeps a build cache between runs", () => {
    expect(backendSupportsIncremental("tsgo")).toBe(true);
    expect(backendSupportsIncremental("bun")).toBe(false);
  });
});

describe("getBunPath", () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[BUN_PATH_ENV];
    delete process.env[BUN_PATH_ENV];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[BUN_PATH_ENV];
    else process.env[BUN_PATH_ENV] = savedEnv;
  });

  test("prefers an explicit path over everything else", () => {
    process.env[BUN_PATH_ENV] = "/from/env/bun";

    expect(getBunPath("/explicit/bun")).toBe("/explicit/bun");
  });

  test("uses the environment variable when no path is given", () => {
    process.env[BUN_PATH_ENV] = "/from/env/bun";

    expect(getBunPath()).toBe("/from/env/bun");
  });

  test("falls back to the Bun running this process", () => {
    // The test suite itself runs under Bun
    expect(getBunPath()).toBe(process.execPath);
  });
});

describe("getBunCheckInvocation", () => {
  const input = {
    rootDir: resolve("/projects/app"),
    tsconfigPath: resolve("/projects/app/.fast-check/tsconfig.json"),
  };

  test("does not start in the project, so a `check` package script cannot shadow the built-in", () => {
    const { cwd } = getBunCheckInvocation(input);

    expect(cwd).toBe(tmpdir());
    expect(cwd.startsWith(input.rootDir)).toBe(false);
  });

  test("points the checker at the project and its generated tsconfig", () => {
    const { args } = getBunCheckInvocation(input);

    expect(args[0]).toBe("check");
    expect(args[args.indexOf("--cwd") + 1]).toBe(input.rootDir);
    expect(args[args.indexOf("-p") + 1]).toBe(input.tsconfigPath);
  });

  test("asks for one ungrouped line per error", () => {
    const { args } = getBunCheckInvocation(input);

    expect(args).toContain("--no-pretty");
    expect(args).toContain("--all");
  });
});

describe("findTsconfigErrors", () => {
  const rootDir = resolve("/projects/app");
  const tsconfigPath = resolve(rootDir, ".fast-check/tsconfig.json");

  function diag(file: string, code: number): Diagnostic {
    return { file, line: 1, column: 1, code, message: "m", severity: "error" };
  }

  test("picks out diagnostics reported against the generated tsconfig", () => {
    const configError = diag(".fast-check/tsconfig.json", 5102);
    const diagnostics = [
      configError,
      diag("src/utils.ts", 2322),
      diag(".fast-check/tsx/src/App.svelte.tsx", 2322),
      // The project's own tsconfig is not the generated one
      diag("tsconfig.json", 5023),
    ];

    expect(findTsconfigErrors(diagnostics, rootDir, tsconfigPath)).toEqual([
      configError,
    ]);
  });

  test("returns nothing when only source files have errors", () => {
    expect(
      findTsconfigErrors([diag("src/utils.ts", 2322)], rootDir, tsconfigPath),
    ).toEqual([]);
  });
});

describe("generateTsconfig with options TypeScript 7 removed", () => {
  let rootDir: string;

  async function generate(compilerOptions: Record<string, unknown>) {
    writeFileSync(
      resolve(rootDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions }),
    );
    const tsconfigPath = await generateTsconfig({
      rootDir,
      srcDir: resolve(rootDir, "src"),
    });
    return JSON.parse(readFileSync(tsconfigPath, "utf-8")).compilerOptions;
  }

  beforeEach(() => {
    rootDir = mkdtempSync(resolve(tmpdir(), "sfc-backends-"));
    mkdirSync(resolve(rootDir, ".fast-check"), { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  test("replaces baseUrl with an equivalent catch-all path mapping", async () => {
    const options = await generate({ baseUrl: "./src" });

    expect(options.baseUrl).toBeUndefined();
    expect(options.paths).toEqual({ "*": ["../src/*"] });
  });

  test("keeps aliases that were declared relative to baseUrl", async () => {
    const options = await generate({
      baseUrl: ".",
      paths: { "~/*": ["src/*"] },
    });

    expect(options.baseUrl).toBeUndefined();
    expect(options.paths).toEqual({ "*": ["../*"], "~/*": ["../src/*"] });
  });

  test.each([
    "node",
    "node10",
    "Node",
    "classic",
  ])("overrides removed moduleResolution %p with bundler", async (moduleResolution) => {
    const options = await generate({ moduleResolution, module: "commonjs" });

    expect(options.moduleResolution).toBe("bundler");
    expect(options.module).toBe("esnext");
  });

  test("drops removed options that do not affect a type check", async () => {
    const options = await generate({ downlevelIteration: true, strict: true });

    expect(options.downlevelIteration).toBeUndefined();
    expect(options.strict).toBe(true);
  });

  test("only enables the incremental build cache when asked to", async () => {
    writeFileSync(resolve(rootDir, "tsconfig.json"), "{}");
    const config = { rootDir, srcDir: resolve(rootDir, "src") };
    const read = (path: string) =>
      JSON.parse(readFileSync(path, "utf-8")).compilerOptions;

    const withCache = read(
      await generateTsconfig(config, { incremental: true }),
    );
    expect(withCache.incremental).toBe(true);
    expect(withCache.tsBuildInfoFile).toBe("./.tsbuildinfo");

    const withoutCache = read(
      await generateTsconfig(config, { incremental: false }),
    );
    expect(withoutCache.incremental).toBe(false);
    expect(withoutCache.tsBuildInfoFile).toBeUndefined();
  });
});
