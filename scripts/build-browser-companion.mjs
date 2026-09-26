#!/usr/bin/env node
/**
 * Builds and packages the HCR Browser Companion (Manifest V3 extension).
 *
 * Invoked by the root `npm run build` so the extension is always available at:
 *   GET http://127.0.0.1:7876/downloads/hcr-browser-companion.zip
 *
 * Output:
 *   apps/browser-companion/dist/                     (load-unpacked folder)
 *   apps/browser-companion/hcr-browser-companion.zip (download artifact - the
 *       extension files sit at the zip root, no nested dist/ folder)
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const extRoot = join(repoRoot, 'apps', 'browser-companion');
const srcRoot = join(extRoot, 'src');
const distRoot = join(extRoot, 'dist');
const zipPath = join(extRoot, 'hcr-browser-companion.zip');

async function bundle() {
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });

  const common = {
    bundle: true,
    target: 'chrome110',
    logLevel: 'warning',
    absWorkingDir: repoRoot,
  };

  await build({
    ...common,
    entryPoints: [join(srcRoot, 'background.ts')],
    outfile: join(distRoot, 'background.js'),
    format: 'esm',
  });
  await build({
    ...common,
    entryPoints: [join(srcRoot, 'content.ts')],
    outfile: join(distRoot, 'content.js'),
    format: 'iife',
  });
  await build({
    ...common,
    entryPoints: [join(srcRoot, 'popup.ts')],
    outfile: join(distRoot, 'popup.js'),
    format: 'iife',
  });

  for (const file of ['manifest.json', 'popup.html']) {
    const content = await readFile(join(extRoot, file));
    await writeFile(join(distRoot, file), content);
  }

  // Toolbar/popup icons (static PNG assets referenced by manifest.json).
  const iconsRoot = join(extRoot, 'icons');
  if (existsSync(iconsRoot)) {
    const iconsDist = join(distRoot, 'icons');
    await mkdir(iconsDist, { recursive: true });
    for (const name of await readdir(iconsRoot)) {
      await writeFile(join(iconsDist, name), await readFile(join(iconsRoot, name)));
    }
  }
}

// ---------------------------------------------------------------------- //
// Minimal ZIP writer (DEFLATE via node:zlib) - no third-party dependency. //
// ---------------------------------------------------------------------- //

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const time =
    (Math.floor(date.getHours() / 2) << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function buildZip(entries) {
  const { time, day } = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuffer, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

async function collectFiles(dir, base) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await collectFiles(full, base)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

async function packageZip() {
  const files = await collectFiles(distRoot, distRoot);
  const entries = [];
  for (const file of files) {
    const rel = relative(distRoot, file).split('\\').join('/');
    entries.push({
      name: rel,
      data: await readFile(file),
    });
  }
  const zip = buildZip(entries);
  await writeFile(zipPath, zip);
  return { count: entries.length, bytes: zip.length };
}

async function main() {
  if (!existsSync(join(srcRoot, 'background.ts'))) {
    console.error('Browser Companion sources not found.');
    process.exit(1);
  }

  await bundle();
  const { count, bytes } = await packageZip();
  const digest = createHash('sha256').update(await readFile(zipPath)).digest('hex').slice(0, 12);
  const size = (await stat(zipPath)).size;

  console.log('Browser Companion build complete:');
  console.log(`  dist  : ${relative(repoRoot, distRoot)}`);
  console.log(`  zip   : ${relative(repoRoot, zipPath)} (${size} bytes, ${count} files)`);
  console.log(`  sha256: ${digest}…`);
}

await main();
