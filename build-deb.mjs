#!/usr/bin/env node
/**
 * ==============================================================================
 * Vanill-IA OS — Portable Debian Package (.deb) Builder (Node.js)
 * Produces a 100% spec-compliant Debian 2.0 binary package (`ar` + POSIX USTAR
 * `control.tar.gz` + `data.tar.gz` with root:root 0:0 ownership and exact UNIX modes)
 * even on Windows hosts without WSL or dpkg-deb!
 * ==============================================================================
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_SRC = path.join(ROOT_DIR, 'package');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

const controlRaw = fs.readFileSync(path.join(PKG_SRC, 'DEBIAN', 'control'), 'utf8').replace(/\r\n/g, '\n');
const pkgName = (controlRaw.match(/^Package:\s*(.+)$/m)?.[1] || 'vanill-ia-os').trim();
const pkgVersion = process.argv[2] || (controlRaw.match(/^Version:\s*(.+)$/m)?.[1] || '1.0.0').trim();
const pkgArch = (controlRaw.match(/^Architecture:\s*(.+)$/m)?.[1] || 'all').trim();
const mtimeSec = Math.floor(Date.now() / 1000);

const REQUIRED_EMPTY_DIRS = [
  'etc/caddy/conf.d',
  'etc/fail2ban/filter.d',
  'etc/fail2ban/jail.d',
  'etc/systemd/system',
  'usr/local/bin',
  'usr/share/vanill-ia-os/apps',
  'var/lib/vanill-ia-os/data',
  'var/lib/vanill-ia-os/apps',
  'var/lib/vanill-ia-os/notes',
  'var/lib/vanill-ia-os/stacks',
  'var/lib/vanill-ia-os/tmp',
];

function writeOctal(buf, value, offset, length) {
  const oct = value.toString(8).padStart(length - 1, '0');
  buf.write(oct, offset, length - 1, 'ascii');
  buf[offset + length - 1] = 0;
}

function createTarEntryHeader({ name, mode, size, typeflag }) {
  const header = Buffer.alloc(512, 0);

  let prefix = '';
  let shortName = name;
  if (Buffer.byteLength(name) > 100) {
    const slashIdx = name.lastIndexOf('/', name.length - 2);
    prefix = name.slice(0, slashIdx);
    shortName = name.slice(slashIdx + 1);
  }

  header.write(shortName, 0, Math.min(100, Buffer.byteLength(shortName)), 'utf8');
  writeOctal(header, mode, 100, 8);
  writeOctal(header, 0, 108, 8); // uid = 0 (root)
  writeOctal(header, 0, 116, 8); // gid = 0 (root)
  writeOctal(header, size, 124, 12);
  writeOctal(header, mtimeSec, 136, 12);
  header.fill(0x20, 148, 156); // spaces for checksum calculation
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  header.write('root', 265, 4, 'ascii');
  header.write('root', 297, 4, 'ascii');
  if (prefix) {
    header.write(prefix, 345, Math.min(155, Buffer.byteLength(prefix)), 'utf8');
  }

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const chkOct = sum.toString(8).padStart(6, '0');
  header.write(chkOct, 148, 6, 'ascii');
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

function buildTarGz(entries) {
  const chunks = [];
  for (const entry of entries) {
    const isDir = entry.type === 'dir';
    const data = isDir ? Buffer.alloc(0) : entry.data;
    const tarName = isDir ? (entry.name.endsWith('/') ? entry.name : `${entry.name}/`) : entry.name;
    chunks.push(
      createTarEntryHeader({
        name: tarName,
        mode: entry.mode,
        size: data.length,
        typeflag: isDir ? '5' : '0',
      })
    );
    if (data.length > 0) {
      chunks.push(data);
      const remainder = data.length % 512;
      if (remainder !== 0) {
        chunks.push(Buffer.alloc(512 - remainder, 0));
      }
    }
  }
  // End-of-archive marker: two 512-byte zero blocks
  chunks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

function createArMember(filename, data) {
  const header = Buffer.alloc(60, 0x20);
  header.write(filename.slice(0, 16), 0, 'ascii');
  header.write(String(mtimeSec), 16, 'ascii');
  header.write('0', 28, 'ascii');
  header.write('0', 34, 'ascii');
  header.write('100644', 40, 'ascii');
  header.write(String(data.length), 48, 'ascii');
  header[58] = 0x60; // `
  header[59] = 0x0A; // \n

  const pad = data.length % 2 === 1 ? Buffer.from([0x0A]) : Buffer.alloc(0);
  return Buffer.concat([header, data, pad]);
}

function normalizeFileBuffer(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  const raw = fs.readFileSync(absPath);
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico'].includes(ext)) {
    return raw;
  }
  return Buffer.from(raw.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

// Auto-sync version in source files before packaging (guarantees PWA Service Worker cache invalidation on every .deb release)
const swPath = path.join(PKG_SRC, 'usr', 'share', 'vanill-ia-os', 'sw.js');
if (fs.existsSync(swPath)) {
  const swSrc = fs.readFileSync(swPath, 'utf8').replace(/\r\n/g, '\n');
  const swUpdated = swSrc.replace(/^const CACHE_VERSION = '[^']+';/m, `const CACHE_VERSION = '${pkgName}-v${pkgVersion}';`);
  if (swUpdated !== swSrc) fs.writeFileSync(swPath, swUpdated, 'utf8');
}
const bootPath = path.join(PKG_SRC, 'usr', 'share', 'vanill-ia-os', 'api', 'bootstrap.php');
if (fs.existsSync(bootPath)) {
  const bootSrc = fs.readFileSync(bootPath, 'utf8').replace(/\r\n/g, '\n');
  const bootUpdated = bootSrc.replace(/^const VANILLIA_VERSION = '[^']+';/m, `const VANILLIA_VERSION = '${pkgVersion}';`);
  if (bootUpdated !== bootSrc) fs.writeFileSync(bootPath, bootUpdated, 'utf8');
}
const agentPath = path.join(PKG_SRC, 'usr', 'local', 'bin', 'vanill-ia-agent');
if (fs.existsSync(agentPath)) {
  const agentSrc = fs.readFileSync(agentPath, 'utf8').replace(/\r\n/g, '\n');
  const agentUpdated = agentSrc.replace(/public const VERSION = '[^']+';/, `public const VERSION = '${pkgVersion}';`);
  if (agentUpdated !== agentSrc) fs.writeFileSync(agentPath, agentUpdated, 'utf8');
}

// 1. Collecte de data.tar.gz
const dataEntriesMap = new Map();
dataEntriesMap.set('./', { name: './', type: 'dir', mode: 0o755 });

function ensureDirHierarchy(relPosix) {
  const parts = relPosix.split('/').filter(Boolean);
  let acc = '.';
  for (const p of parts) {
    acc += '/' + p;
    const mode = (acc === './var/lib/vanill-ia-os/data' || acc === './var/lib/vanill-ia-os/tmp') ? 0o750 : 0o755;
    if (!dataEntriesMap.has(acc)) {
      dataEntriesMap.set(acc, { name: acc, type: 'dir', mode });
    }
  }
}

for (const d of REQUIRED_EMPTY_DIRS) {
  ensureDirHierarchy(d);
}

let installedBytes = 0;

function walkDataTree(currentAbs, relPrefix = '') {
  const items = fs.readdirSync(currentAbs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const it of items) {
    if (relPrefix === '' && it.name === 'DEBIAN') continue;
    if (['.gitkeep', '.DS_Store', 'Thumbs.db'].includes(it.name)) continue;

    const fullAbs = path.join(currentAbs, it.name);
    const relPosix = relPrefix ? `${relPrefix}/${it.name}` : it.name;

    if (it.isDirectory()) {
      ensureDirHierarchy(relPosix);
      walkDataTree(fullAbs, relPosix);
    } else if (it.isFile()) {
      ensureDirHierarchy(path.posix.dirname(relPosix));
      const buf = normalizeFileBuffer(fullAbs);
      installedBytes += buf.length;
      const isBin = relPosix.startsWith('usr/local/bin/') || relPosix.endsWith('.sh');
      dataEntriesMap.set(`./${relPosix}`, {
        name: `./${relPosix}`,
        type: 'file',
        mode: isBin ? 0o755 : 0o644,
        data: buf,
      });
    }
  }
}

walkDataTree(PKG_SRC);
const dataTarGz = buildTarGz(Array.from(dataEntriesMap.values()));

// 2. Collecte de control.tar.gz (avec Installed-Size en Ko)
const installedKb = Math.max(1, Math.ceil(installedBytes / 1024));
let updatedControl = controlRaw.replace(/^Version:\s*.+$/m, `Version: ${pkgVersion}`);
if (!/^Installed-Size:/m.test(updatedControl)) {
  updatedControl = updatedControl.replace(/^Architecture:\s*.+$/m, (m) => `${m}\nInstalled-Size: ${installedKb}`);
}

const controlEntries = [
  { name: './', type: 'dir', mode: 0o755 },
  { name: './control', type: 'file', mode: 0o644, data: Buffer.from(updatedControl.endsWith('\n') ? updatedControl : `${updatedControl}\n`, 'utf8') },
];

for (const metaFile of ['conffiles', 'postinst', 'prerm']) {
  const p = path.join(PKG_SRC, 'DEBIAN', metaFile);
  if (fs.existsSync(p)) {
    const isExec = metaFile === 'postinst' || metaFile === 'prerm';
    controlEntries.push({
      name: `./${metaFile}`,
      type: 'file',
      mode: isExec ? 0o755 : 0o644,
      data: normalizeFileBuffer(p),
    });
  }
}

const controlTarGz = buildTarGz(controlEntries);

// 3. Assemblage de l'archive AR Debian (.deb)
fs.mkdirSync(DIST_DIR, { recursive: true });
const debFilename = `${pkgName}_${pkgVersion}_${pkgArch}.deb`;
const debOutPath = path.join(DIST_DIR, debFilename);

const debBuffer = Buffer.concat([
  Buffer.from('!<arch>\n', 'ascii'),
  createArMember('debian-binary', Buffer.from('2.0\n', 'ascii')),
  createArMember('control.tar.gz', controlTarGz),
  createArMember('data.tar.gz', dataTarGz),
]);

fs.writeFileSync(debOutPath, debBuffer);
const sha256 = crypto.createHash('sha256').update(debBuffer).digest('hex');
fs.writeFileSync(`${debOutPath}.sha256`, `${sha256}  ${debFilename}\n`, 'utf8');

console.log(`==========================================================`);
console.log(`[SUCCÈS] Paquet Debian compilé : dist/${debFilename}`);
console.log(`Taille archive .deb : ${(debBuffer.length / 1024).toFixed(1)} Ko (Installed-Size: ${installedKb} Ko)`);
console.log(`SHA-256 : ${sha256}`);
console.log(`==========================================================`);
