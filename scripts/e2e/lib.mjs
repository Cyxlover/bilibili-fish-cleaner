// 真机 E2E 的共享工具：把三次踩坑的结论固化下来，新脚本不要再自己写一套。
//
// 三条硬规则（都是血泪换来的）：
//   1) 滚动只用 wheel()（内部是 page.mouse.wheel）。用 window.scrollBy 会撞上 B 站站内跳转，
//      page.evaluate 抛 "Execution context was destroyed, most likely because of a navigation"，
//      脚本若没有 try/catch 就会一直重试到工具超时。
//   2) 面板内容在 shadow DOM 里，document.body.innerText 恒为空，必须用 readShadowText()。
//   3) 用完立刻关页面、finally 里关 context、最后杀残留 msedge，否则 profile 被占用、内存爆掉。
//
// playwright-core 不属于本仓库依赖，按绝对路径从研究工具目录取。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const EDGE = process.env.DSHCC_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
export const PROFILE = process.env.DSHCC_PROFILE || join(ROOT, '.e2e-profile');
export const REPORT_DIR = join(ROOT, '.scratch', 'comment-cleanup', 'validation', 'e2e-real');
export const PANEL_PAGE = 'src/sidepanel/sidepanel.html';

const PLAYWRIGHT_DIRS = [
  join(ROOT, '.scratch', 'comment-cleanup', 'tools-dom', 'node_modules'),
  join(ROOT, 'node_modules'),
];

export function loadPlaywright() {
  for (const dir of PLAYWRIGHT_DIRS) {
    if (!existsSync(join(dir, 'playwright-core'))) continue;
    const require = createRequire(join(dir, 'noop.js'));
    return require('playwright-core');
  }
  throw new Error('找不到 playwright-core：本仓库不引入依赖，请确认 .scratch/comment-cleanup/tools-dom/node_modules 还在');
}

export function watchdog(ms = 150000) {
  const timer = setTimeout(() => {
    console.error(`WATCHDOG：${ms}ms 未跑完，强制退出（已完成部分见日志）`);
    process.exit(2);
  }, ms);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export async function launch(playwright, options = {}) {
  // 允许传 playwright 模块，也允许直接传 chromium（两种写法都常见，传错了会很难查）。
  const mod = playwright || loadPlaywright();
  const chromium = mod.chromium || mod;
  const context = await chromium.launchPersistentContext(PROFILE, {
    executablePath: EDGE,
    headless: options.headless ?? false,
    viewport: options.viewport ?? { width: 1280, height: 900 },
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
      '--no-default-browser-check',
      // 固定 profile 用久了会攒下「上次未关闭的标签页」，Edge 一启动就把它们全部恢复，
      // 十几个视频页同时加载会把机器和网络打满，于是 goto/screenshot 全部超时（真实踩过）。
      '--no-restore-last-session',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      ...(options.args || []),
    ],
  });
  context.__pages = new Set();
  await pruneRestoredPages(context);
  return context;
}

// 启动后只留一个空白页：恢复出来的历史标签一律关掉。
export async function pruneRestoredPages(context) {
  const pages = context.pages();
  const keep = pages.find((page) => page.url() === 'about:blank') || pages[0];
  for (const page of pages) {
    if (page === keep) continue;
    await page.close().catch(() => {});
  }
  if (!keep) await context.newPage();
  return context.pages().length;
}

export async function openVideo(context, bvid, options = {}) {
  const page = await context.newPage();
  context.__pages.add(page);
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200));
  });
  await page.goto(`https://www.bilibili.com/video/${bvid}/`, {
    waitUntil: 'domcontentloaded',
    timeout: options.timeout ?? 60000,
  });
  await page.waitForTimeout(options.settleMs ?? 3000);
  await page
    .waitForFunction(() => !!document.querySelector('#commentapp'), null, { timeout: options.waitMs ?? 15000 })
    .catch(() => {});
  return { page, bvid, consoleErrors };
}

export async function wheel(page, times = 1, delta = 1800) {
  for (let index = 0; index < times; index += 1) {
    await page.mouse.wheel(0, delta);
    await page.waitForTimeout(600);
  }
}

// 读 shadow DOM 里的文本；宿主不存在或未挂 shadowRoot 时返回 null（调用方自行判断）。
export async function readShadowText(page, selector) {
  return page.evaluate((sel) => {
    const host = document.querySelector(sel);
    return host && host.shadowRoot ? host.shadowRoot.textContent.trim() : null;
  }, selector);
}

export async function openPanel(context, extensionId, options = {}) {
  const page = await context.newPage();
  context.__pages.add(page);
  await page.goto(`chrome-extension://${extensionId}/${PANEL_PAGE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(options.settleMs ?? 1500);
  return page;
}

export async function closePage(context, page, closed = []) {
  if (!page || page.isClosed()) return;
  await page.close().catch(() => {});
  context.__pages.delete(page);
  closed.push(page.url().slice(-40));
}

export async function closeAll(context, hygiene = {}) {
  if (!context) return hygiene;
  for (const page of [...(context.__pages || [])]) {
    await page.close().catch(() => {});
  }
  context.__pages?.clear();
  await Promise.race([context.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
  hygiene.contextClosed = true;
  return hygiene;
}

// 残留 Edge 必须按命令行匹配仓库路径杀：profile 名带中文，按 *e2e-profile* 匹配不到。
export function killLeftoverEdge() {
  if (process.platform !== 'win32') return 0;
  const script = [
    "$p = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\"",
    `$hits = @($p | Where-Object { $_.CommandLine -like '*${ROOT.replace(/'/g, "''")}*' })`,
    '$hits | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
    '$hits.Count',
  ].join('; ');
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  const count = Number.parseInt((out.stdout || '0').trim(), 10);
  return Number.isFinite(count) ? count : 0;
}

// 证据文件只增不改：文件名带时间戳，绝不覆盖上一份报告。
export async function writeReport(name, data) {
  await mkdir(REPORT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(REPORT_DIR, `${name}-${stamp}.json`);
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}
