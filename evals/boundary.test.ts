import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// The write boundary (master plan §5): only executor/ may import the PayPal
// write client. ESLint enforces the same rule; this test catches anything the
// linter misses, such as a dynamic import() or a require().

const root = join(__dirname, "..");
const skipDirs = new Set(["node_modules", ".next", ".git", "prototype", "coverage", "out", "dist"]);
const writeClientRef = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'][^"']*paypal\/write-client(?:\.[jt]sx?)?["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return skipDirs.has(entry.name) ? [] : sourceFiles(path);
    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [path] : [];
  });
}

describe("PayPal write boundary", () => {
  it("only executor/ imports paypal/write-client", () => {
    const offenders = sourceFiles(root)
      .map((file) => relative(root, file).split(sep).join("/"))
      .filter((file) => !file.startsWith("executor/") && file !== "evals/boundary.test.ts")
      .filter((file) => writeClientRef.test(readFileSync(join(root, file), "utf8")));

    expect(offenders).toEqual([]);
  });

  it("the pattern catches every import style", () => {
    for (const line of [
      'import { remind } from "@/paypal/write-client";',
      "import * as w from '../paypal/write-client.ts';",
      'const w = await import("../../paypal/write-client");',
      'const w = require("./paypal/write-client.js");',
    ]) {
      expect(line).toMatch(writeClientRef);
    }
    expect('import { search } from "@/paypal/read-client";').not.toMatch(writeClientRef);
  });
});
