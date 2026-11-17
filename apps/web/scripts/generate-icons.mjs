#!/usr/bin/env node
/**
 * PWA の仮アイコンを作る（依存ゼロ。PNG を zlib で直接書く）。
 *
 * 本制作のアイコンが届いたら（計画書 O-8）、public/icons/ の 4 ファイルを差し替えるだけでよい。
 * ファイル名と寸法は manifest.webmanifest と index.html が参照しているので変えないこと
 * （scripts/check-pwa.mjs が寸法まで照合する）。
 *
 * 実行: node apps/web/scripts/generate-icons.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const outDir = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public', 'icons');

// index.html の theme-color / index.css の --action と同じ値
const BG = [0x63, 0x5b, 0xff];
const FG = [0xff, 0xff, 0xff];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * 塗りつぶしの正方形に白い「F」を置く。
 * `safe` は文字を収める中央の割合。maskable は円形に切られても欠けないよう 0.5（仕様の安全域は 80% の円）。
 */
function icon(size, safe) {
  const box = size * safe;
  const x0 = (size - box) / 2;
  const y0 = (size - box) / 2;
  const stroke = box * 0.2;
  // F の 3 本: 縦棒、上の横棒、中の横棒（左寄せを避けて中央に見えるよう少し右へ）
  const left = x0 + box * 0.22;
  const rects = [
    [left, y0, left + stroke, y0 + box],
    [left, y0, x0 + box * 0.84, y0 + stroke],
    [left, y0 + box * 0.42, x0 + box * 0.72, y0 + box * 0.42 + stroke],
  ];
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1);
    raw[row] = 0; // フィルタ無し
    for (let x = 0; x < size; x++) {
      const on = rects.some(([a, b, c, d]) => x + 0.5 >= a && x + 0.5 < c && y + 0.5 >= b && y + 0.5 < d);
      const px = on ? FG : BG;
      raw.set(px, row + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
const files = [
  ['icon-192.png', 192, 0.62],
  ['icon-512.png', 512, 0.62],
  ['icon-maskable-512.png', 512, 0.5],
  ['apple-touch-icon.png', 180, 0.62],
];
for (const [name, size, safe] of files) {
  writeFileSync(join(outDir, name), icon(size, safe));
  process.stdout.write(`wrote public/icons/${name} (${size}x${size})\n`);
}
