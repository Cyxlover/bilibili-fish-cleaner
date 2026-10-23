#!/usr/bin/env node
// 零依赖总检：语法、引擎产物新鲜度、manifest 完整性、单元测试、规则回归。
//
//   node scripts/check.mjs          # 全量
//   node scripts/check.mjs --fast   # 提交前用：跳过规则回归（慢）
//
// 每一项都必须真跑，失败即整体失败（退出码 1）。不引入任何依赖。

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FAST = process.argv.includes('--fast');
const results = [];

function record(name, ok, detail, ms) {
  results.push({ name, ok, detail, ms });
}

function walk(dir, out = [], pattern = /\.(m?js)$/) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out, pattern);
    else if (pattern.test(entry)) out.push(full);
  }
  return out;
}

function node(args, opts = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: opts.timeout ?? 120000,
    env: { ...process.env, ...(opts.env || {}) },
  });
}

// 1. 语法：每个源码文件都过一遍 node --check
function checkSyntax() {
  const files = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'tools')), ...walk(join(ROOT, 'engine'))];
  const bad = [];
  for (const file of files) {
    const out = node(['--check', file], { timeout: 20000 });
    if (out.status !== 0) bad.push(`${relative(ROOT, file)}: ${(out.stderr || '').trim().split('\n')[0]}`);
  }
  return { ok: bad.length === 0, detail: bad.length ? bad.join('\n') : `${files.length} 个文件通过` };
}

// 2. 引擎产物：engine/ 改动后必须重建，否则线上跑的是旧规则
function checkEngineFresh() {
  const out = node(['scripts/build-engine.mjs', '--check']);
  const text = `${out.stdout || ''}${out.stderr || ''}`.trim();
  return { ok: out.status === 0, detail: text || `退出码 ${out.status}` };
}

// 3. manifest：列进去的文件必须都存在，否则加载时才空指针
function checkManifest() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const missing = [];
  const require = (p) => {
    if (!p) return;
    if (!existsSync(join(ROOT, p))) missing.push(p);
  };
  for (const block of manifest.content_scripts || []) {
    for (const file of block.js || []) require(file);
    for (const file of block.css || []) require(file);
  }
  require(manifest.background?.service_worker);
  require(manifest.side_panel?.default_path);
  for (const value of Object.values(manifest.icons || {})) require(value);
  for (const value of Object.values(manifest.action?.default_icon || {})) require(value);

  // 一个脚本要么被 manifest 加载，要么被扩展页面 HTML 用 <script src> 加载，否则等于死文件
  const loaded = new Set((manifest.content_scripts || []).flatMap((b) => b.js || []));
  loaded.add(manifest.background?.service_worker);
  for (const page of walk(join(ROOT, 'src'), [], /\.html$/)) {
    const base = dirname(page);
    const html = readFileSync(page, 'utf8');
    for (const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)) {
      loaded.add(relative(ROOT, resolve(base, match[1])).replace(/\\/g, '/'));
    }
  }
  const orphans = [...walk(join(ROOT, 'src'))]
    .filter((f) => f.endsWith('.js'))
    .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
    .filter((rel) => !loaded.has(rel));

  const problems = [...missing.map((m) => `缺失: ${m}`), ...orphans.map((o) => `未列入 manifest: ${o}`)];
  return { ok: problems.length === 0, detail: problems.length ? problems.join('\n') : `${loaded.size} 个脚本有加载入口` };
}

// 4. 单元测试：全量，包含 test/engine 的规则回归用例
function checkTests() {
  const files = [
    ...walk(join(ROOT, 'test')).filter((f) => f.endsWith('.test.mjs')),
    ...walk(join(ROOT, 'test', 'engine')).filter((f) => f.endsWith('.test.js')),
  ];
  const out = node(['--test', ...files], { timeout: 300000 });
  const text = `${out.stdout || ''}${out.stderr || ''}`;
  const pass = (text.match(/^# pass (\d+)/m) || text.match(/^\u2139 pass (\d+)/m) || [])[1];
  const fail = (text.match(/^# fail (\d+)/m) || text.match(/^\u2139 fail (\d+)/m) || [])[1];
  const ok = out.status === 0 && fail === '0';
  return { ok, detail: ok ? `${pass} 项通过` : `pass=${pass} fail=${fail}\n${text.split('\n').slice(-15).join('\n')}` };
}

// 5. 规则回归：95 项真实样本台账
function checkRegression() {
  const out = node(['tools/regression.mjs'], { timeout: 300000 });
  const text = `${out.stdout || ''}${out.stderr || ''}`.trim();
  return { ok: out.status === 0, detail: text.split('\n').slice(-3).join(' / ') };
}

const checks = [
  ['语法', checkSyntax],
  ['引擎产物新鲜度', checkEngineFresh],
  ['manifest 完整性', checkManifest],
  ['单元测试', checkTests],
];
if (!FAST) checks.push(['规则回归', checkRegression]);

for (const [name, fn] of checks) {
  const started = Date.now();
  let result;
  try {
    result = fn();
  } catch (error) {
    result = { ok: false, detail: error.message };
  }
  record(name, result.ok, result.detail, Date.now() - started);
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${name}  (${Date.now() - started}ms)`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('\n失败详情：');
  for (const item of failed) console.log(`\n[${item.name}]\n${item.detail}`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过' + (FAST ? '（快速模式，未跑规则回归）' : ''));
}
