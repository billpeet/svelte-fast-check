/**
 * Type checker backends
 *
 * A backend runs a type checker against the generated tsconfig and returns its
 * diagnostics as tsc-style lines (`file(line,col): error TS1234: message`),
 * with file paths relative to the project root.
 *
 * - tsgo: the TypeScript 7 native compiler (default)
 * - bun:  Bun's built-in `bun check`
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export const BACKEND_NAMES = ["tsgo", "bun"] as const;

/** Type checker used for the type check step */
export type BackendName = (typeof BACKEND_NAMES)[number];

export const DEFAULT_BACKEND: BackendName = "tsgo";

/** Environment variable that overrides which Bun executable `bun check` uses */
export const BUN_PATH_ENV = "SVELTE_FAST_CHECK_BUN";

export function isBackendName(value: unknown): value is BackendName {
  return BACKEND_NAMES.includes(value as BackendName);
}

/**
 * Whether the backend can reuse results between runs (tsBuildInfo).
 * `bun check` has no incremental mode, so it always checks from scratch.
 */
export function backendSupportsIncremental(backend: BackendName): boolean {
  return backend === "tsgo";
}

export interface BackendRunInput {
  /** Project root directory; diagnostics are reported relative to it */
  rootDir: string;
  /** Absolute path to the generated tsconfig.json */
  tsconfigPath: string;
  /** Bun executable to use for the bun backend (overrides auto-detection) */
  bunPath?: string;
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a process and collect its output.
 *
 * Uses spawn instead of spawnSync to avoid ENOBUFS on large projects:
 * spawnSync has buffer size limits, spawn streams output without limits.
 */
function runProcess(
  label: string,
  command: string,
  args: string[],
  cwd: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("error", (err) => {
      reject(new Error(`${label} execution failed: ${err.message}`));
    });

    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    });
  });
}

/**
 * Resolve the TypeScript 7 (native) compiler launcher.
 *
 * TypeScript 7 is installed under the `typescript7` alias so it can sit next to
 * the project's own `typescript` (5.x/6.x), whose JS API svelte2tsx still needs.
 */
export function getTsgoPath(): string {
  const packageJsonPath = require.resolve("typescript7/package.json");
  return join(dirname(packageJsonPath), "bin", "tsc");
}

async function runTsgo(input: BackendRunInput): Promise<string> {
  const { code, stdout, stderr } = await runProcess(
    "tsgo",
    "node",
    [getTsgoPath(), "--noEmit", "-p", input.tsconfigPath],
    input.rootDir,
  );

  const output = stdout + stderr;
  if (code !== 0 && output.trim() === "") {
    throw new Error(`tsgo execution failed with exit code ${code}.`);
  }
  return output;
}

/**
 * Resolve the Bun executable for `bun check`.
 *
 * Priority: explicit path > SVELTE_FAST_CHECK_BUN > the Bun running this
 * process > `bun` on PATH.
 */
export function getBunPath(explicitPath?: string): string {
  if (explicitPath) return explicitPath;

  const fromEnv = process.env[BUN_PATH_ENV];
  if (fromEnv) return fromEnv;

  return process.versions.bun ? process.execPath : "bun";
}

/**
 * Arguments and working directory for `bun check`.
 *
 * `bun check` runs the project's `check` package.json script instead of the
 * built-in type checker when one exists, and it finds that script by walking
 * up from the working directory. So the process is started in a neutral
 * directory, and `--cwd` points the checker back at the project, which also
 * keeps diagnostic paths relative to the project root.
 */
export function getBunCheckInvocation(input: BackendRunInput): {
  cwd: string;
  args: string[];
} {
  return {
    cwd: tmpdir(),
    args: [
      "check",
      "--cwd",
      input.rootDir,
      "-p",
      input.tsconfigPath,
      // One line per error, and no grouping of identical errors
      "--no-pretty",
      "--all",
    ],
  };
}

async function runBunCheck(input: BackendRunInput): Promise<string> {
  const bunPath = getBunPath(input.bunPath);
  const { cwd, args } = getBunCheckInvocation(input);

  let result: ProcessResult;
  try {
    result = await runProcess("bun check", bunPath, args, cwd);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${detail}\nThe bun backend needs Bun installed. Set ${BUN_PATH_ENV} or the "bunPath" config option to point at a Bun executable.`,
    );
  }

  // Diagnostics go to stdout; stderr only carries the summary, or the reason
  // nothing was checked.
  const { code, stdout, stderr } = result;
  if (code !== 0 && stdout.trim() === "") {
    if (/Script not found/i.test(stderr)) {
      throw new Error(
        `This version of Bun (${bunPath}) has no built-in "bun check" type checker. Upgrade Bun, or set ${BUN_PATH_ENV} or the "bunPath" config option to a Bun executable that has it.`,
      );
    }
    throw new Error(
      `bun check failed with exit code ${code}.${stderr.trim() ? `\n${stderr.trim()}` : ""}`,
    );
  }
  return stdout;
}

/**
 * Run the type checker and return its tsc-style output
 */
export function runBackend(
  backend: BackendName,
  input: BackendRunInput,
): Promise<string> {
  return backend === "bun" ? runBunCheck(input) : runTsgo(input);
}
