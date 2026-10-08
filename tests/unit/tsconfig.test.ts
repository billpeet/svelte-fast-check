/**
 * Unit tests for reading the project's tsconfig.json and its `extends` chain
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  generateTsconfig,
  readTypesFromTsconfig,
  resolveExtendsPath,
} from "../../src/typecheck/convert";

let rootDir: string;

/** Write a file under the temp project, creating parent directories */
function write(relativePath: string, content: string | object): string {
  const filePath = resolve(rootDir, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return filePath;
}

beforeEach(() => {
  rootDir = mkdtempSync(resolve(tmpdir(), "sfc-tsconfig-"));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe("resolveExtendsPath", () => {
  test("resolves a relative path with and without the .json extension", () => {
    const base = write("config/base.json", {});

    expect(resolveExtendsPath("./config/base.json", rootDir)).toBe(base);
    expect(resolveExtendsPath("./config/base", rootDir)).toBe(base);
  });

  test("resolves SvelteKit 3's $app/tsconfig from node_modules", () => {
    const generated = write("node_modules/$app/tsconfig.json", {});

    expect(resolveExtendsPath("$app/tsconfig", rootDir)).toBe(generated);
  });

  test("resolves a package directory to its tsconfig.json", () => {
    const shared = write("node_modules/@tsconfig/svelte/tsconfig.json", {});

    expect(resolveExtendsPath("@tsconfig/svelte", rootDir)).toBe(shared);
    expect(resolveExtendsPath("@tsconfig/svelte/tsconfig.json", rootDir)).toBe(
      shared,
    );
  });

  test("walks up to a node_modules in a parent directory", () => {
    const shared = write("node_modules/shared-config/tsconfig.json", {});
    mkdirSync(resolve(rootDir, "packages/web"), { recursive: true });

    expect(
      resolveExtendsPath("shared-config", resolve(rootDir, "packages/web")),
    ).toBe(shared);
  });

  test("returns null when nothing matches", () => {
    expect(resolveExtendsPath("./missing", rootDir)).toBeNull();
    expect(resolveExtendsPath("sfc-no-such-package-xyz", rootDir)).toBeNull();
  });
});

describe("readTypesFromTsconfig", () => {
  test("inherits compiler options through $app/tsconfig", () => {
    write("node_modules/$app/tsconfig.json", {
      compilerOptions: {
        strict: false,
        moduleResolution: "bundler",
        types: ["$app/types"],
        paths: { $lib: ["../../src/lib"], "$lib/*": ["../../src/lib/*"] },
      },
    });
    write("tsconfig.json", {
      extends: "$app/tsconfig",
      compilerOptions: { strict: true },
      include: ["src"],
    });

    const result = readTypesFromTsconfig(rootDir);

    expect(result?.compilerOptions?.strict).toBe(true);
    expect(result?.compilerOptions?.moduleResolution).toBe("bundler");
    expect(result?.compilerOptions?.types).toEqual(["$app/types"]);
    // paths are made absolute, relative to the tsconfig that declared them
    expect(result?.compilerOptions?.paths).toEqual({
      $lib: [resolve(rootDir, "src/lib")],
      "$lib/*": [resolve(rootDir, "src/lib/*")],
    });
    expect(result?.include).toEqual(["src"]);
  });

  test("parses tsconfig files with comments and trailing commas", () => {
    write(
      "tsconfig.json",
      `{
  // comments are allowed in tsconfig.json
  "compilerOptions": {
    "strict": true, /* and so are block comments */
  },
}`,
    );

    expect(readTypesFromTsconfig(rootDir)?.compilerOptions?.strict).toBe(true);
  });

  test("merges an extends array, with later entries winning", () => {
    write("a.json", { compilerOptions: { strict: false, target: "es2020" } });
    write("b.json", { compilerOptions: { strict: true }, exclude: ["b-only"] });
    write("tsconfig.json", {
      extends: ["./a.json", "./b"],
      compilerOptions: { noEmit: true },
    });

    const result = readTypesFromTsconfig(rootDir);

    expect(result?.compilerOptions).toEqual({
      strict: true,
      target: "es2020",
      noEmit: true,
    });
    expect(result?.exclude).toEqual(["b-only"]);
  });

  test("resolves paths against baseUrl when it is set", () => {
    write("tsconfig.json", {
      compilerOptions: { baseUrl: "./src", paths: { "~/*": ["./*"] } },
    });

    expect(readTypesFromTsconfig(rootDir)?.compilerOptions?.paths).toEqual({
      "~/*": [resolve(rootDir, "src/*")],
    });
  });

  test("warns and keeps its own options when extends cannot be resolved", () => {
    write("tsconfig.json", {
      extends: "sfc-no-such-package-xyz",
      compilerOptions: { strict: true },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      const result = readTypesFromTsconfig(rootDir);

      expect(result?.compilerOptions).toEqual({ strict: true });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "sfc-no-such-package-xyz",
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("does not loop on circular extends", () => {
    write("a.json", { extends: "./tsconfig.json" });
    write("tsconfig.json", {
      extends: "./a.json",
      compilerOptions: { strict: true },
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(readTypesFromTsconfig(rootDir)?.compilerOptions?.strict).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("generateTsconfig", () => {
  test("rewrites inherited paths relative to the generated tsconfig", async () => {
    write("node_modules/$app/tsconfig.json", {
      compilerOptions: {
        strict: true,
        paths: { $lib: ["../../src/lib"], "$lib/*": ["../../src/lib/*"] },
      },
    });
    write("tsconfig.json", {
      extends: "$app/tsconfig",
      compilerOptions: { paths: { "$utils/*": ["./src/utils/*"] } },
    });
    mkdirSync(resolve(rootDir, ".fast-check"), { recursive: true });

    const tsconfigPath = await generateTsconfig({
      rootDir,
      srcDir: resolve(rootDir, "src"),
    });
    const generated = JSON.parse(readFileSync(tsconfigPath, "utf-8"));

    expect(generated.compilerOptions.strict).toBe(true);
    // Own `paths` replaces the inherited one, as in TypeScript
    expect(generated.compilerOptions.paths).toEqual({
      "$utils/*": ["../src/utils/*"],
    });
  });

  test("keeps $lib pointing at src/lib for SvelteKit 3's generated config", async () => {
    write("node_modules/$app/tsconfig.json", {
      compilerOptions: {
        paths: { $lib: ["../../src/lib"], "$lib/*": ["../../src/lib/*"] },
      },
    });
    write("tsconfig.json", { extends: "$app/tsconfig" });
    mkdirSync(resolve(rootDir, ".fast-check"), { recursive: true });

    const tsconfigPath = await generateTsconfig({
      rootDir,
      srcDir: resolve(rootDir, "src"),
    });
    const generated = JSON.parse(readFileSync(tsconfigPath, "utf-8"));

    expect(generated.compilerOptions.paths).toEqual({
      $lib: ["../src/lib"],
      "$lib/*": ["../src/lib/*"],
    });
  });
});
