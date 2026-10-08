/**
 * E2E tests for the bun backend (`bun check`).
 *
 * These need a Bun that ships the built-in type checker. They use the Bun
 * running the tests, or the one named by SVELTE_FAST_CHECK_BUN, and are
 * skipped when that Bun has no `bun check`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runFastCheck } from "../src/index";
import { getBunPath } from "../src/typecheck/backends";
import type {
  CheckResult,
  FastCheckConfig,
  MappedDiagnostic,
} from "../src/types";

const fixturesDir = resolve(import.meta.dir, "fixtures");

/** Whether the available Bun has the built-in type checker */
function hasBunCheck(): boolean {
  // Run outside any project so a `check` package script cannot answer instead
  const result = spawnSync(getBunPath(), ["check", "--help"], {
    cwd: tmpdir(),
    encoding: "utf-8",
  });
  return result.status === 0 && /type check/i.test(result.stdout ?? "");
}

const bunCheckAvailable = hasBunCheck();
if (!bunCheckAvailable) {
  console.warn(
    `Skipping bun backend E2E tests: ${getBunPath()} has no built-in "bun check".`,
  );
}

function configFor(fixture: string): FastCheckConfig {
  const rootDir = resolve(fixturesDir, fixture);
  return { rootDir, srcDir: resolve(rootDir, "src") };
}

/** Location and code of each diagnostic, for comparing two runs */
function summarize(diagnostics: MappedDiagnostic[]): string[] {
  return diagnostics
    .map(
      (d) =>
        `${d.originalFile}:${d.originalLine}:${d.originalColumn} TS${d.code}`,
    )
    .sort();
}

describe.skipIf(!bunCheckAvailable)("bun backend E2E", () => {
  const fixtures = [
    "valid-project",
    "error-project",
    "store-error-project",
    "monorepo-project",
    "component-props-error",
  ];

  afterAll(() => {
    for (const fixture of fixtures) {
      rmSync(resolve(fixturesDir, fixture, ".fast-check"), {
        recursive: true,
        force: true,
      });
    }
  });

  describe.each(fixtures)("%s", (fixture) => {
    let tsgoResult: CheckResult;
    let bunResult: CheckResult;

    beforeAll(async () => {
      const options = { quiet: true, svelteWarnings: false };
      // Sequential: both runs share the fixture's cache directory
      tsgoResult = await runFastCheck(configFor(fixture), {
        ...options,
        backend: "tsgo",
      });
      bunResult = await runFastCheck(configFor(fixture), {
        ...options,
        backend: "bun",
      });
    });

    test("reports the same diagnostics as the tsgo backend", () => {
      expect(summarize(bunResult.diagnostics)).toEqual(
        summarize(tsgoResult.diagnostics),
      );
      expect(bunResult.errorCount).toBe(tsgoResult.errorCount);
    });
  });

  test("finds errors in a project whose package.json has a `check` script", async () => {
    // error-project defines a failing `check` script. `bun check` would run it
    // instead of the type checker if it were started inside the project.
    const result = await runFastCheck(configFor("error-project"), {
      quiet: true,
      svelteWarnings: false,
      backend: "bun",
    });

    expect(result.errorCount).toBe(7);
    expect(
      result.diagnostics.some((d) => d.originalFile.endsWith("App.svelte")),
    ).toBe(true);
  });

  test("can be selected through the config object", async () => {
    const result = await runFastCheck(
      { ...configFor("error-project"), backend: "bun" },
      { quiet: true, svelteWarnings: false },
    );

    expect(result.errorCount).toBe(7);
  });

  test("keeps working in incremental mode, without a build cache", async () => {
    const options = {
      quiet: true,
      svelteWarnings: false,
      incremental: true,
      backend: "bun" as const,
    };

    const first = await runFastCheck(configFor("error-project"), options);
    const second = await runFastCheck(configFor("error-project"), options);

    expect(first.errorCount).toBe(7);
    expect(summarize(second.diagnostics)).toEqual(summarize(first.diagnostics));
  });
});

describe("bun backend without a usable Bun", () => {
  test("fails with a clear message when the executable does not exist", async () => {
    const run = runFastCheck(
      {
        ...configFor("valid-project"),
        bunPath: resolve(tmpdir(), "sfc-no-such-bun-executable"),
      },
      { quiet: true, svelteWarnings: false, backend: "bun" },
    );

    await expect(run).rejects.toThrow(/bun backend needs Bun installed/);
    rmSync(resolve(fixturesDir, "valid-project", ".fast-check"), {
      recursive: true,
      force: true,
    });
  });

  test("rejects an unknown backend name", async () => {
    const run = runFastCheck(configFor("valid-project"), {
      quiet: true,
      // @ts-expect-error deliberately invalid
      backend: "tsc",
    });

    await expect(run).rejects.toThrow(/Unknown backend "tsc"/);
  });
});
