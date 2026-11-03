// Skill packages for the Abdulrahman Saad Motion panel: add a skill from a .zip / .skill file or a folder, and export one as a .zip
// to give to other people (the same zip also uploads to claude.ai). Plain Node (zlib only), so it works the same on
// Windows and macOS with no unzip tool.
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

// never copied: the skill's own save history, macOS / Windows junk
const SKIP = /(^|\/)(\.history|__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;

// ------------------------------------------------------------------ zip reading (stored + deflate: what Windows, macOS and Claude make)
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('NOT_ZIP');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('NOT_ZIP');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen).replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (/\/$/.test(name)) continue;                                                       // a folder entry
    if (flags & 1) throw new Error('ENCRYPTED');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new Error('ZIP_METHOD_' + method);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) });
  }
  return out;
}

// ------------------------------------------------------------------ zip writing (deflate, UTF-8 names)
// An entry may carry a unix `mode` (e.g. 0o755): macOS then keeps the file executable when it unzips it
// (needed for a double-clickable .command installer).
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
function crc32(b) { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
function writeZip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'), data = zlib.deflateRawSync(e.data), crc = crc32(e.data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(0, 10); h.writeUInt16LE(0x21, 12);                                   // 1980-01-01 00:00
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(e.data.length, 22);
    h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
    const c = Buffer.alloc(46);
    const unix = e.mode != null;
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(unix ? 0x0314 : 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(0, 12); c.writeUInt16LE(0x21, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    if (unix) c.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38);                    // regular file + permissions
    parts.push(h, name, data); central.push(c, name);
    offset += h.length + name.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat(parts.concat([cd, end]));
}

// ------------------------------------------------------------------ skills
function frontmatterName(text) {
  const fm = /^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ''));
  const n = fm && /^name:\s*(.+)$/m.exec(fm[1]);
  return n ? n[1].trim().replace(/^["']|["']$/g, '') : '';
}
// Claude Code skill names: lowercase letters, digits and hyphens
function safeName(s) { return String(s || '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, ''); }

function folderEntries(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n), r = rel ? rel + '/' + n : n;
      if (SKIP.test(r)) continue;
      if (fs.statSync(p).isDirectory()) walk(p, r); else out.push({ name: r, data: fs.readFileSync(p) });
    }
  })(dir, '');
  return out;
}
// the files of the skill inside a package, relative to the folder that holds SKILL.md (the shallowest one)
function skillFiles(entries) {
  const md = entries.filter((e) => /(^|\/)SKILL\.md$/i.test(e.name) && !SKIP.test(e.name))
    .sort((a, b) => a.name.split('/').length - b.name.split('/').length)[0];
  if (!md) throw new Error('NO_SKILL_MD');
  const root = md.name.slice(0, md.name.length - 'SKILL.md'.length);
  return entries.filter((e) => e.name.startsWith(root) && !SKIP.test(e.name)).map((e) => ({ name: e.name.slice(root.length), data: e.data }));
}

// Add a skill from a .zip / .skill file (path or Buffer), a folder, a SKILL.md path, or a list of {name, data} files.
// It goes to <skillsDir>/<its name>; a skill already there with that name is moved to backupsDir first (never deleted).
function installSkill(source, skillsDir, backupsDir, fallbackName) {
  let entries;
  if (Array.isArray(source)) entries = source;
  else if (Buffer.isBuffer(source)) entries = readZip(source);
  else if (fs.statSync(source).isDirectory()) entries = folderEntries(source);
  else if (/(^|[\\/])SKILL\.md$/i.test(source)) entries = folderEntries(path.dirname(source));
  else entries = readZip(fs.readFileSync(source));
  const files = skillFiles(entries);
  const md = files.find((f) => f.name.toLowerCase() === 'skill.md');
  const name = safeName(frontmatterName(md.data.toString('utf8'))) || safeName(fallbackName) || 'skill';
  const dest = path.join(skillsDir, name);
  let replaced = null;
  if (fs.existsSync(dest)) {
    fs.mkdirSync(backupsDir, { recursive: true });
    replaced = path.join(backupsDir, name + '-' + new Date().toISOString().replace(/[:.]/g, '-'));
    fs.renameSync(dest, replaced);
  }
  let count = 0;
  for (const f of files) {
    const p = path.resolve(dest, f.name);
    if (!p.startsWith(dest + path.sep)) continue;                                        // no writing outside the skill folder
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.data);
    count++;
  }
  return { name, path: dest, files: count, replaced };
}

// The skill folder as <outFile> (.zip with the folder at its root: unzips to one folder, uploads to claude.ai as is).
function exportSkill(skillDir, outFile) {
  const folder = safeName(path.basename(skillDir)) || 'skill';
  const entries = folderEntries(skillDir).map((e) => ({ name: folder + '/' + e.name, data: e.data }));
  if (!entries.some((e) => /\/SKILL\.md$/i.test(e.name))) throw new Error('NO_SKILL_MD');
  fs.writeFileSync(outFile, writeZip(entries));
  return { file: outFile, files: entries.length };
}

module.exports = { readZip, writeZip, crc32, frontmatterName, safeName, installSkill, exportSkill };
