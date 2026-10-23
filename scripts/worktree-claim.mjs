#!/usr/bin/env node
// worktree 认领锁：同一时刻一个 worktree 只能有一个写者。
//
//   node scripts/worktree-claim.mjs ticket-03            # 认领，已被占用则退出码 1
//   node scripts/worktree-claim.mjs ticket-03 --release  # 释放
//   node scripts/worktree-claim.mjs --list               # 看当前持有者
//
// 背景：本仓库曾被三个代理先后/并发写入同一个 .worktrees/ticket-05，结果是重复实现
// 与死代码（一个整文件死代码被审查才发现）。锁是原子的（mkdir 一旦成功即独占），
// 不依赖 git 分支状态。

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLAIM_DIR = join(ROOT, '.worktrees', '.claims');
const args = process.argv.slice(2);

function holderOf(name) {
  const file = join(CLAIM_DIR, name);
  try {
    return JSON.parse(readFileSync(join(file, 'owner.json'), 'utf8'));
  } catch {
    return { tag: '(锁目录存在但读不到 owner.json)', pid: null, at: null };
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function list() {
  if (!existsSync(CLAIM_DIR)) {
    console.log('当前没有被认领的 worktree');
    return;
  }
  const names = readdirSync(CLAIM_DIR).filter((n) => !n.startsWith('.'));
  if (!names.length) console.log('当前没有被认领的 worktree');
  for (const name of names) {
    const holder = holderOf(name);
    const state = alive(holder.pid) ? '持有中' : '疑似残留（进程已退出）';
    console.log(`${name}\t${state}\t持有者=${holder.tag}\tpid=${holder.pid}\t于=${holder.at}`);
  }
}

if (args.includes('--list') || args.length === 0) {
  list();
  process.exit(0);
}

const name = args.find((a) => !a.startsWith('--'));
if (!name) {
  console.error('用法：node scripts/worktree-claim.mjs <名字> [--release]');
  process.exit(2);
}

const lockDir = join(CLAIM_DIR, name);

// Windows 上把整个目录连同 owner.json 删掉会失败（删除挂起：目录内有句柄未释放，
// rmSync 不抛错但删不掉，rmdirSync 报 ENOTEMPTY）。所以「释放」= 原子重命名让出名字，
// 删除只做尽力而为；残留的 .stale-* 目录因为以点开头，不会影响任何名字的占用判断。
function vacate(dir, label) {
  const stale = join(CLAIM_DIR, `.stale-${label}-${Date.now()}`);
  try {
    renameSync(dir, stale);
  } catch {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* 尽力而为 */
    }
    return false;
  }
  try {
    rmSync(stale, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* 删不掉就留着，不影响正确性 */
  }
  return true;
}

if (args.includes('--release')) {
  if (!existsSync(lockDir)) {
    console.log(`${name} 未被认领，无需释放`);
    process.exit(0);
  }
  vacate(lockDir, name);
  console.log(`已释放 ${name}`);
  process.exit(0);
}

mkdirSync(CLAIM_DIR, { recursive: true });
try {
  mkdirSync(lockDir); // 原子：已存在即抛错
} catch {
  const holder = holderOf(name);
  // 认领进程写完就退出，pid 天然是死的——所以「pid 不在了」绝不能当成可自动接管，
  // 否则锁形同虚设。要么持有者自己 --release，要么明确 --force 覆盖。
  if (args.includes('--force')) {
    vacate(lockDir, name);
    mkdirSync(lockDir);
    console.log(`已强制接管 ${name}（原持有者 ${holder.tag} pid ${holder.pid}）`);
  } else {
    console.error(`无法认领 ${name}：已被占用`);
    console.error(`  持有者: ${holder.tag}`);
    console.error(`  pid: ${holder.pid}  于: ${holder.at}  ${alive(holder.pid) ? '' : '(该进程已退出，属正常：认领进程写完即退)'}`);
    console.error(`  确认对方已完工：node scripts/worktree-claim.mjs ${name} --release`);
    console.error(`  确认对方已失联：node scripts/worktree-claim.mjs ${name} --force`);
    process.exit(1);
  }
}

const branch = spawnSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).stdout?.trim();
const owner = {
  tag: process.env.DSHCC_AGENT || process.env.USERNAME || process.env.USER || 'unknown',
  pid: process.pid,
  at: new Date().toISOString(),
  branch: branch || null,
};
writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
console.log(`已认领 ${name}（持有者 ${owner.tag}，pid ${owner.pid}）`);
console.log(`完成或交接时释放：node scripts/worktree-claim.mjs ${name} --release`);
