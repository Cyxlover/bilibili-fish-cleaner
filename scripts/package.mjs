// 打包成可直接分发的 zip：只放运行时需要的文件，不带测试、研究数据与开发脚本。
// 用法：node scripts/package.mjs [--out <目录>]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const argOut = process.argv.indexOf('--out');
const OUT_DIR = argOut > -1 ? path.resolve(process.argv[argOut + 1]) : path.join(ROOT, 'dist');

/** 进包的东西：manifest + 图标 + 运行时脚本 + 用户文档。 */
const INCLUDE = ['manifest.json', 'icons', 'src', 'README.md', 'INSTALL.md', 'LICENSE'];

/** 即便在 INCLUDE 目录里也要剔掉的：测试、快照、临时文件。 */
const EXCLUDE = [/\.test\.(m?js)$/i, /^test$/i, /__tests?__/i, /\.map$/i, /\.DS_Store$/i, /Thumbs\.db$/i];

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const zipName = `bilibili-fish-cleaner-v${manifest.version}.zip`;
const stageName = `bilibili-fish-cleaner-v${manifest.version}`;

function walk(dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (EXCLUDE.some((re) => re.test(entry.name))) continue;
    if (entry.isDirectory()) walk(abs, relPath, out);
    else if (entry.isFile()) out.push(relPath);
  }
  return out;
}

function rmrf(target) {
  if (!fs.existsSync(target)) return;
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
}

// 1) 收集文件并校验
const files = [];
for (const item of INCLUDE) {
  const abs = path.join(ROOT, item);
  if (!fs.existsSync(abs)) throw new Error(`缺少打包内容：${item}`);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) walk(abs, item, files);
  else files.push(item);
}

// 2) 包内自洽性：manifest 引用的每个路径都必须真的在包里
const referenced = new Set();
for (const p of Object.values(manifest.icons || {})) referenced.add(p);
for (const p of Object.values((manifest.action || {}).default_icon || {})) referenced.add(p);
for (const cs of manifest.content_scripts || []) for (const p of cs.js || []) referenced.add(p);
if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
if (manifest.side_panel?.default_path) referenced.add(manifest.side_panel.default_path);
// 扩展页面自己 <script src> 引用的文件也算
for (const rel of files.filter((f) => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const dir = path.posix.dirname(rel);
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const raw = m[1];
    if (/^(https?:)?\/\//.test(raw)) continue;
    referenced.add(path.posix.normalize(path.posix.join(dir, raw)).replace(/^\.\//, ''));
  }
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)) {
    const raw = m[1];
    if (/^(https?:)?\/\//.test(raw)) continue;
    referenced.add(path.posix.normalize(path.posix.join(dir, raw)).replace(/^\.\//, ''));
  }
}
const missing = [...referenced].filter((p) => !files.includes(p));
if (missing.length) throw new Error(`manifest/页面引用了未打包的文件：\n  ${missing.join('\n  ')}`);

// 3) 准备暂存目录
rmrf(path.join(OUT_DIR, stageName));
fs.mkdirSync(path.join(OUT_DIR, stageName), { recursive: true });
for (const rel of files) {
  const dest = path.join(OUT_DIR, stageName, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dest);
}

// 4) 打 zip（用系统自带的 Compress-Archive，避免引入依赖）
const zipPath = path.join(OUT_DIR, zipName);
rmrf(zipPath);
execFileSync(
  'powershell',
  ['-NoProfile', '-NonInteractive', '-Command', `Compress-Archive -Path '${path.join(OUT_DIR, stageName, '*')}' -DestinationPath '${zipPath}' -Force`],
  { stdio: 'inherit' }
);

const bytes = files.reduce((n, f) => n + fs.statSync(path.join(ROOT, f)).size, 0);
const kb = (n) => (n / 1024).toFixed(1) + ' KB';
console.log(`打包完成：${zipPath}`);
console.log(`  版本 ${manifest.version}　文件 ${files.length} 个　原始体积 ${kb(bytes)}　zip ${kb(fs.statSync(zipPath).size)}`);
console.log('  内容：' + INCLUDE.join('、'));
