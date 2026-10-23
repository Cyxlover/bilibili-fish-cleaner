#!/usr/bin/env node
// 启用仓库自带的 git 钩子（钩子本体在 scripts/git-hooks/，随仓库版本管理）。
//   node scripts/install-hooks.mjs
//
// 只写本地 git config（core.hooksPath），不改动 .git/hooks 里的样例文件。

import { spawnSync } from 'node:child_process';
import { chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = 'scripts/git-hooks';

const configured = spawnSync('git', ['config', 'core.hooksPath', HOOKS], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (configured.status !== 0) {
  console.error(configured.stderr || '设置 core.hooksPath 失败');
  process.exit(1);
}

// POSIX 上钩子需要可执行位；Windows 上 git 用自带 sh 执行，无需可执行位。
for (const name of ['pre-commit', 'pre-push']) {
  try {
    chmodSync(join(ROOT, HOOKS, name), 0o755);
  } catch {
    // Windows 上可能失败，忽略
  }
}

console.log(`已启用 git 钩子：core.hooksPath = ${HOOKS}`);
console.log('  pre-commit  拦截凭据类文件 + 快速自检');
console.log('  pre-push    全量自检（含规则回归）');
