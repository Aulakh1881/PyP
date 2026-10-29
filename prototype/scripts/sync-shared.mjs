// Copies the shared Pyp code into the extension and the website.
// Chrome loads an unpacked extension from its own folder only, and the website is
// deployed on its own, so each gets a copy. Edit files in /shared, then run:
//
//   npm run sync          copy shared/ into extension/shared and website/shared
//   npm run sync -- --check   fail if any copy is out of date (used in CI)

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'shared');
const targets = [join(root, 'extension', 'shared'), join(root, 'website', 'shared')];
const check = process.argv.includes('--check');

const files = (await readdir(src)).filter((f) => f.endsWith('.js'));
let stale = 0;

for (const dir of targets) {
  await mkdir(dir, { recursive: true });
  for (const f of files) {
    const want = await readFile(join(src, f), 'utf8');
    let have = null;
    try { have = await readFile(join(dir, f), 'utf8'); } catch { /* missing */ }
    if (have === want) continue;
    if (check) {
      console.error(`out of date: ${join(dir, f)}`);
      stale++;
    } else {
      await writeFile(join(dir, f), want);
      console.log(`copied ${f} -> ${dir}`);
    }
  }
}

if (check && stale) {
  console.error('Run `npm run sync` to update the copies.');
  process.exit(1);
}
