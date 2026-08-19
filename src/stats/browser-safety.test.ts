import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Architecture tests.
 *
 * The stats and hygiene layers run in the user's browser tab — that is what makes
 * "your ratings never leave your machine" true. Anything that pulls a Node builtin
 * or the SQLite store into that graph breaks the bundle, and it breaks it at build
 * time in a confusing way rather than here in a clear one.
 */

const BROWSER_DIRS = ["src/stats", "src/hygiene"];

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

test("no browser-bound module imports a node: builtin", async () => {
  for (const dir of BROWSER_DIRS) {
    for (const file of await sourceFiles(dir)) {
      const src = await readFile(file, "utf8");
      const hits = [...src.matchAll(/from\s+["']node:([^"']+)["']/g)].map((m) => m[1]);
      assert.deepEqual(hits, [], `${file} imports node:${hits.join(", ")} — it cannot run in a browser`);
    }
  }
});

test("no browser-bound module imports the SQLite store", async () => {
  for (const dir of BROWSER_DIRS) {
    for (const file of await sourceFiles(dir)) {
      const src = await readFile(file, "utf8");
      // db.ts imports node:sqlite, so even a type import is a trap waiting for
      // someone to drop the `type` keyword. Types live in store/types.ts.
      assert.ok(
        !/from\s+["'][^"']*store\/db\.ts["']/.test(src),
        `${file} imports store/db.ts — import from store/types.ts instead`,
      );
    }
  }
});

test("the shared types module itself has no imports at all", async () => {
  const src = await readFile("src/store/types.ts", "utf8");
  assert.ok(!/^import /m.test(src), "store/types.ts must stay dependency-free");
});
