// Draws the app icon (orange hexagon + six coloured project dots on a dark tile).
// Writes build/icon.png (1024px, used for macOS/Linux) and build/icon.ico (256px PNG-in-ICO, Windows).
const fs = require("fs"), zlib = require("zlib"), path = require("path");

function render(S) {
  const px = Buffer.alloc(S * S * 4), k = S / 256;                       // design space is 256x256
  const inHex = (x, y, r) => { const dx = Math.abs(x), dy = Math.abs(y); return dy <= r * 0.866 && dx * 0.866 + dy * 0.5 <= r * 0.866; };
  const DOTS = [[79, 140, 255], [245, 184, 61], [47, 211, 166], [178, 119, 255], [255, 93, 122], [123, 224, 90]];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const cx = (x - S / 2 + .5) / k, cy = (y - S / 2 + .5) / k, d = Math.hypot(cx, cy);
    let c = [0, 0, 0, 0];
    if (inHex(cy, cx, 124)) c = [14, 16, 24, 255];                          // dark tile
    if (inHex(cy, cx, 70) && !inHex(cy, cx, 56)) c = [255, 138, 61, 255];   // orange hex ring
    if (d < 14) c = [255, 170, 100, 255];                                   // core
    DOTS.forEach((col, i) => { const t = i * Math.PI / 3; if (Math.hypot(cx - Math.cos(t) * 98, cy - Math.sin(t) * 98) < 9) c = [...col, 255]; });
    px.set(c, (y * S + x) * 4);
  }
  return png(S, px);
}

function png(S, px) {
  const table = []; for (let n = 0; n < 256; n++) { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = (b) => { let r = 0xffffffff; for (const v of b) r = table[(r ^ v) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((S * 4 + 1) * S); for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function ico(pngBuf) {                                                       // one 256px PNG entry
  const head = Buffer.alloc(22); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12); head.writeUInt32LE(pngBuf.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, pngBuf]);
}

const out = path.join(__dirname, "..", "build");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "icon.png"), render(1024));
fs.writeFileSync(path.join(out, "icon.ico"), ico(render(256)));
console.log("build/icon.png (1024px) + build/icon.ico (256px) written");
