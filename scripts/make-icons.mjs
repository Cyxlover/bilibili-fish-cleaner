// 生成扩展图标（零依赖，直接写 PNG）。
//
// 用法：node scripts/make-icons.mjs
// 产物：icons/icon-{16,32,48,128}.png
//
// 图案：圆角深蓝底 + 白色鲸鱼剪影（身体 + 尾巴 + 眼睛），3×3 超采样抗锯齿。

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const OUT_DIR = fileURLToPath(new URL('../icons/', import.meta.url));
const SIZES = [16, 32, 48, 128];

const BACKDROP = [0x25, 0x5f, 0xd6, 0xff]; // #255fd6
const BODY = [0xff, 0xff, 0xff, 0xff];
const EYE = [0x25, 0x5f, 0xd6, 0xff];

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 圆角矩形（归一化坐标）
function insideRoundedRect(x, y, inset, radius) {
  const min = inset;
  const max = 1 - inset;
  if (x < min || x > max || y < min || y > max) {
    return false;
  }
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

// 鲸鱼身体：横椭圆
function insideBody(x, y) {
  const dx = (x - 0.46) / 0.31;
  const dy = (y - 0.56) / 0.21;
  return dx * dx + dy * dy <= 1;
}

// 尾巴：右侧三角
function insideTail(x, y) {
  if (x < 0.70 || x > 0.95) {
    return false;
  }
  const t = (x - 0.70) / 0.25; // 0..1
  const half = 0.05 + 0.14 * t;
  return Math.abs(y - 0.53) <= half;
}

function insideEye(x, y) {
  const dx = x - 0.33;
  const dy = y - 0.48;
  return dx * dx + dy * dy <= 0.045 * 0.045;
}

function sampleRgba(x, y) {
  // x/y ∈ [0,1)，返回该点颜色（或 null = 透明）
  if (insideEye(x, y)) {
    return EYE;
  }
  if (insideBody(x, y) || insideTail(x, y)) {
    return insideRoundedRect(x, y, 0.06, 0.22) ? BODY : null;
  }
  if (insideRoundedRect(x, y, 0.06, 0.22)) {
    return BACKDROP;
  }
  return null;
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const sub = 3;
  const step = 1 / (size * sub);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let hits = 0;
      for (let sy = 0; sy < sub; sy += 1) {
        for (let sx = 0; sx < sub; sx += 1) {
          const x = (px * sub + sx + 0.5) * step;
          const y = (py * sub + sy + 0.5) * step;
          const color = sampleRgba(x, y);
          if (color) {
            r += color[0];
            g += color[1];
            b += color[2];
            a += color[3];
            hits += 1;
          }
        }
      }
      const offset = (py * size + px) * 4;
      if (hits === 0) {
        rgba[offset] = 0;
        rgba[offset + 1] = 0;
        rgba[offset + 2] = 0;
        rgba[offset + 3] = 0;
        continue;
      }
      // 预乘后按覆盖数求平均，得到边缘的软过渡
      const total = sub * sub;
      rgba[offset] = Math.round(r / hits);
      rgba[offset + 1] = Math.round(g / hits);
      rgba[offset + 2] = Math.round(b / hits);
      rgba[offset + 3] = Math.round((a / hits) * (hits / total));
    }
  }
  return encodePng(size, size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon-${size}.png`);
  writeFileSync(file, renderIcon(size));
  console.log(`wrote ${file}`);
}
