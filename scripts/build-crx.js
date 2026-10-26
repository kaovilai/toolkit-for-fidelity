#!/usr/bin/env node
// node build-crx.js <extDir> <out.crx> [--update-url URL]
// Key: env CRX_PEM_B64 (base64 PEM, e.g. GH secret) or CRX_PEM_FILE. Same key => same extension ID forever.
// Stages a copy of extDir, injects manifest.update_url (keep it OUT of the Web Store manifest), zips, signs CRX3.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), cp = require('child_process');
const [dir, out] = process.argv.slice(2, 4);
const ui = process.argv.indexOf('--update-url');
const updateUrl = ui > 0 ? process.argv[ui + 1] : null;
const pem = process.env.CRX_PEM_B64 ? Buffer.from(process.env.CRX_PEM_B64, 'base64') : fs.readFileSync(process.env.CRX_PEM_FILE);
const key = crypto.createPrivateKey(pem);
const spki = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' });

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-'));
fs.cpSync(dir, stage + '/ext', { recursive: true });
const mp = stage + '/ext/manifest.json';
const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
if (updateUrl) m.update_url = updateUrl;
fs.writeFileSync(mp, JSON.stringify(m, null, 2));
const zipPath = stage + '/ext.zip';
cp.execFileSync('zip', ['-qr', zipPath, '.', '-x', '*.DS_Store', '.git/*'], { cwd: stage + '/ext' });
const zip = fs.readFileSync(zipPath);

const varint = (n) => { const o = []; for (; n > 0x7f; n = Math.floor(n / 128)) o.push((n & 0x7f) | 0x80); o.push(n); return Buffer.from(o); };
const field = (n, d) => Buffer.concat([varint(n * 8 + 2), varint(d.length), d]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const idBytes = crypto.createHash('sha256').update(spki).digest().subarray(0, 16);
const signed = field(1, idBytes);
const sig = crypto.sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), u32(signed.length), signed, zip]), key);
const header = Buffer.concat([field(2, Buffer.concat([field(1, spki), field(2, sig)])), field(10000, signed)]);
fs.writeFileSync(out, Buffer.concat([Buffer.from('Cr24'), u32(3), u32(header.length), header, zip]));
const id = [...idBytes].map((b) => String.fromCharCode(97 + (b >> 4), 97 + (b & 15))).join('');
console.log(JSON.stringify({ id, version: m.version, out }));
fs.rmSync(stage, { recursive: true, force: true });
