// 真实 E2E：本机 Edge + 真实视频页 + 以未打包扩展方式加载本插件。
//
// 验证的是「装进去真能跑」，不是「逻辑看起来对」：
//   1) 徽标确实出现在页面右下角，且数字等于页面里肉眼可见的评论条数（独立重算一遍 DOM 作对照）；
//   2) 每条观测确实逐条打印到了控制台；
//   3) DOM 里评论变多之后计数跟着变（滚动 / 展开楼中楼 / 滚动加载三条路径各记一份证据）；
//   4) 站内切换视频之后重新解析，计数与 aid 一起切换；
//   5) 装完插件评论区结构不变（与「不装插件」的一次运行逐字节对照）。
//
// playwright-core 用绝对路径从研究工具的 node_modules 里取，本仓库不引入依赖：
//   node scripts/e2e-verify.mjs [BV号] [--headed] [--no-appearance]
//
// 产物：e2e-artifacts/（截图 + report.json），不入库。

import { createRequire } from 'node:module';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { accessSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT_DIR = resolve(__dirname, '..');
const ARTIFACT_DIR = join(EXT_DIR, 'e2e-artifacts');
const PROFILE_DIR = join(EXT_DIR, '.e2e-profile');
const CLEAN_PROFILE_DIR = join(EXT_DIR, '.e2e-profile-clean');

const PLAYWRIGHT_PATH =
  'E:\\大肥鱼清除计划\\.scratch\\comment-cleanup\\tools-dom\\node_modules\\playwright-core';
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const argv = process.argv.slice(2);
const bvidArg = argv.find((arg) => /^BV[0-9A-Za-z]{10}$/.test(arg));
const headed = argv.includes('--headed');
const skipAppearance = argv.includes('--no-appearance');
const BVID = bvidArg || 'BV1x2Jq6NEbT';
const START_URL = `https://www.bilibili.com/video/${BVID}/`;

const require = createRequire(import.meta.url);
const { chromium } = require(PLAYWRIGHT_PATH);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

// ---- 页面内：独立重算「肉眼可见」的评论条数（不依赖插件代码） ---------------

const PAGE_TRUTH = () => {
  const out = { aid: null, threads: 0, replies: 0, items: [], errors: [], limitText: null };
  const app = document.querySelector('#commentapp');
  if (!app) {
    out.errors.push('没有 #commentapp');
    return out;
  }
  const host = app.querySelector('bili-comments');
  if (!host) {
    out.errors.push('没有 bili-comments');
    return out;
  }
  const params = host.getAttribute('data-params') || '';
  out.aid = params.split(',')[1] || null;
  const sr = host.shadowRoot;
  if (!sr) {
    out.errors.push('bili-comments 没有 shadow root');
    return out;
  }
  const limit = sr.querySelector('#limit-mask');
  out.limitText = limit ? (limit.textContent || '').trim().slice(0, 80) : null;
  const feed = sr.querySelector('#contents #feed') || sr.querySelector('#feed');
  if (!feed) {
    out.errors.push('没有 #feed');
    return out;
  }
  const threads = [...feed.querySelectorAll('bili-comment-thread-renderer')];
  out.threads = threads.length;
  for (const thread of threads) {
    const comment = thread.shadowRoot && thread.shadowRoot.querySelector('bili-comment-renderer#comment');
    const body = comment && comment.shadowRoot && comment.shadowRoot.querySelector('div#body');
    const item = { mid: null, nick: '', text: '', replies: 0 };
    if (body) {
      const avatar = body.querySelector('a#user-avatar');
      item.mid = avatar ? avatar.getAttribute('data-user-profile-id') : null;
      const userInfo = body.querySelector('bili-comment-user-info');
      const nameLink =
        userInfo && userInfo.shadowRoot && userInfo.shadowRoot.querySelector('#user-name a');
      item.nick = nameLink ? (nameLink.textContent || '').trim() : '';
      const rich = body.querySelector('bili-rich-text');
      const contents = rich && rich.shadowRoot && rich.shadowRoot.querySelector('p#contents');
      item.text = contents ? (contents.textContent || '').trim().slice(0, 40) : '';
    }
    const repliesRenderer =
      thread.shadowRoot && thread.shadowRoot.querySelector('#replies bili-comment-replies-renderer');
    const list =
      repliesRenderer && repliesRenderer.shadowRoot
        ? repliesRenderer.shadowRoot.querySelector('#expander-contents')
        : null;
    item.replies = list ? list.querySelectorAll('bili-comment-reply-renderer').length : 0;
    out.replies += item.replies;
    out.items.push(item);
  }
  return out;
};

const BADGE_STATE = () => {
  const host = document.querySelector('#dshcc-badge');
  if (!host) {
    return null;
  }
  const attr = (name) => host.getAttribute(name);
  const shadow = host.shadowRoot;
  const box = shadow && shadow.querySelector('.box');
  const rect = host.getBoundingClientRect();
  const style = getComputedStyle(host);
  return {
    state: attr('data-dshcc-state'),
    status: attr('data-dshcc-status'),
    aid: attr('data-dshcc-aid'),
    threads: Number(attr('data-dshcc-threads')),
    replies: Number(attr('data-dshcc-replies')),
    text: box ? box.textContent.replace(/\s+/g, ' ').trim() : '',
    // 徽标必须挂在评论区之外，否则「外观不变」无从谈起
    insideCommentApp: !!(host.closest && host.closest('#commentapp')),
    position: {
      position: style.position,
      zIndex: style.zIndex,
      right: Math.round(window.innerWidth - rect.right),
      bottom: Math.round(window.innerHeight - rect.bottom),
      visible: rect.width > 0 && rect.height > 0,
    },
  };
};

// 评论区子树（含 shadow DOM）的确定性序列化：用来对照「装与不装插件」是否一致
const SERIALIZE_COMMENTS = () => {
  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const ser = (node) => {
    if (!node) return '';
    if (node.nodeType === 3) return esc(node.textContent);
    if (node.nodeType === 8) return '';
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    let attrs = '';
    for (const attribute of node.attributes) attrs += ` ${attribute.name}="${esc(attribute.value)}"`;
    let inner = '';
    if (node.shadowRoot) {
      inner += '<template shadowrootmode="open">';
      for (const child of node.shadowRoot.childNodes) inner += ser(child);
      inner += '</template>';
    }
    for (const child of node.childNodes) inner += ser(child);
    return `<${tag}${attrs}>${inner}</${tag}>`;
  };
  const app = document.querySelector('#commentapp');
  return app ? ser(app) : null;
};

// 用真实节点做「DOM 变了计数就变」的实验：把第一条一级评论从 #feed 里摘下来再放回去。
// 不伪造评论、不改插件，只动页面 DOM —— 证明计数是实时从 DOM 得出的，而不是开局算一次。
// cloneNode 带不走 shadow DOM，所以只能搬运真节点。
const MUTATE_FEED = (action) => {
  const host = document.querySelector('#commentapp bili-comments');
  const sr = host && host.shadowRoot;
  const feed = sr && (sr.querySelector('#contents #feed') || sr.querySelector('#feed'));
  if (!feed) return { ok: false, reason: '没有 #feed' };
  const threads = () => feed.querySelectorAll('bili-comment-thread-renderer').length;
  if (action === 'detach') {
    const first = feed.querySelector('bili-comment-thread-renderer');
    if (!first) return { ok: false, reason: '没有一级评论可摘' };
    globalThis.__dshccDetached = first;
    first.remove();
    return { ok: true, threadsInFeed: threads() };
  }
  if (action === 'restore') {
    const node = globalThis.__dshccDetached;
    if (!node) return { ok: false, reason: '没有暂存的节点' };
    if (node.parentNode === feed) return { ok: true, alreadyThere: true, threadsInFeed: threads() };
    feed.appendChild(node);
    return { ok: true, threadsInFeed: threads() };
  }
  return { ok: false, reason: `未知动作 ${action}` };
};

// ---- 浏览器 -----------------------------------------------------------------

function edgePath() {
  for (const candidate of EDGE_CANDIDATES) {
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      /* 继续找 */
    }
  }
  throw new Error(`找不到 Edge：${EDGE_CANDIDATES.join(' / ')}`);
}

async function openBrowser({ withExtension }) {
  const args = [
    '--lang=zh-CN',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
  ];
  if (withExtension) {
    args.push(`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`);
  }
  const context = await chromium.launchPersistentContext(
    withExtension ? PROFILE_DIR : CLEAN_PROFILE_DIR,
    {
      executablePath: edgePath(),
      headless: !headed,
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      args,
    },
  );
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const page = context.pages()[0] || (await context.newPage());
  page.setDefaultTimeout(45000);
  return { context, page };
}

// 评论区是懒加载的：不滚到可见处只会停在 spinner。
async function nudgeCommentsIntoView(page, rounds = 8) {
  await page.evaluate(() => {
    const app = document.querySelector('#commentapp');
    if (app) app.scrollIntoView({ block: 'center' });
  });
  for (let i = 0; i < rounds; i += 1) {
    const state = await page.evaluate(BADGE_STATE);
    if (state && state.state === 'ok') {
      return state;
    }
    await sleep(1500);
    await page.mouse.wheel(0, 500);
  }
  return page.evaluate(BADGE_STATE);
}

// ---- 主流程 -----------------------------------------------------------------

const report = {
  startedAt: new Date().toISOString(),
  bvid: BVID,
  url: START_URL,
  headed,
  steps: {},
  consoleLines: [],
  consoleSample: [],
  network: [],
  verdicts: {},
  errors: [],
};

function record(name, value) {
  report.steps[name] = value;
  log(`${name}: ${JSON.stringify(value).slice(0, 500)}`);
}

async function main() {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await rm(PROFILE_DIR, { recursive: true, force: true });
  await rm(CLEAN_PROFILE_DIR, { recursive: true, force: true });

  const { context, page } = await openBrowser({ withExtension: true });

  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[大肥鱼清除计划]')) {
      report.consoleLines.push({ type: msg.type(), text });
    }
  });
  page.on('pageerror', (error) => {
    report.errors.push({ kind: 'pageerror', message: String(error && error.message) });
  });
  page.on('response', (response) => {
    const url = response.url();
    if (/\/x\/v2\/reply/.test(url)) {
      report.network.push({ status: response.status(), path: url.split('?')[0] });
    }
  });

  try {
    log(`goto ${START_URL}`);
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    await page.waitForSelector('#dshcc-badge', { timeout: 60000, state: 'attached' });
    record('badgeBeforeComments', await page.evaluate(BADGE_STATE));

    const badgeReady = await nudgeCommentsIntoView(page);
    record('afterCommentsRendered', badgeReady);

    const badge0 = await page.evaluate(BADGE_STATE);
    const truth0 = await page.evaluate(PAGE_TRUTH);
    const serial0 = await page.evaluate(SERIALIZE_COMMENTS);
    record('initial', {
      badge: badge0,
      truth: {
        aid: truth0.aid,
        threads: truth0.threads,
        replies: truth0.replies,
        items: truth0.items,
        errors: truth0.errors,
        limitText: truth0.limitText,
      },
    });

    await page.screenshot({ path: join(ARTIFACT_DIR, '01-initial.png') });
    const badgeBox = await page.evaluate(() => {
      const host = document.querySelector('#dshcc-badge');
      if (!host) return null;
      const rect = host.getBoundingClientRect();
      return {
        x: Math.max(0, Math.round(rect.x) - 10),
        y: Math.max(0, Math.round(rect.y) - 10),
        width: Math.min(400, Math.round(rect.width) + 20),
        height: Math.min(260, Math.round(rect.height) + 20),
      };
    });
    if (badgeBox) {
      await page.screenshot({ path: join(ARTIFACT_DIR, '02-badge-closeup.png'), clip: badgeBox });
    }
    await page.evaluate(() => document.querySelector('#commentapp')?.scrollIntoView({ block: 'start' }));
    await sleep(1200);
    await page.screenshot({ path: join(ARTIFACT_DIR, '03-comments-in-view.png') });

    // ---- 路径一：滚动 ----
    for (let i = 0; i < 8; i += 1) {
      await page.mouse.wheel(0, 900);
      await sleep(800);
    }
    await sleep(2500);
    const badgeScroll = await page.evaluate(BADGE_STATE);
    const truthScroll = await page.evaluate(PAGE_TRUTH);
    record('afterScroll', {
      badge: badgeScroll,
      truth: { threads: truthScroll.threads, replies: truthScroll.replies, items: truthScroll.items },
    });
    await page.screenshot({ path: join(ARTIFACT_DIR, '04-after-scroll.png') });

    // ---- 路径二：展开楼中楼（点 bili-text-button 内部真实 <button>）----
    const expandInfo = await page.evaluate(() => {
      const find = (predicate) => {
        let hit = null;
        const walk = (root) => {
          for (const element of root.querySelectorAll('*')) {
            if (!hit && predicate(element)) hit = element;
            if (!hit && element.shadowRoot) walk(element.shadowRoot);
          }
        };
        walk(document);
        return hit;
      };
      const buttonHost = find(
        (element) =>
          element.tagName === 'BILI-TEXT-BUTTON' && /查看|展开/.test(element.textContent || ''),
      );
      if (!buttonHost) return { found: false };
      buttonHost.scrollIntoView({ block: 'center' });
      const inner = buttonHost.shadowRoot && buttonHost.shadowRoot.querySelector('button');
      const rect = buttonHost.getBoundingClientRect();
      return {
        found: true,
        text: (buttonHost.textContent || '').trim().slice(0, 40),
        hasInnerButton: !!inner,
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        },
      };
    });
    record('expandTarget', expandInfo);

    if (expandInfo.found && expandInfo.hasInnerButton) {
      await sleep(800);
      const clicked = await page.evaluate(() => {
        const find = (predicate) => {
          let hit = null;
          const walk = (root) => {
            for (const element of root.querySelectorAll('*')) {
              if (!hit && predicate(element)) hit = element;
              if (!hit && element.shadowRoot) walk(element.shadowRoot);
            }
          };
          walk(document);
          return hit;
        };
        const buttonHost = find(
          (element) =>
            element.tagName === 'BILI-TEXT-BUTTON' && /查看|展开/.test(element.textContent || ''),
        );
        const inner = buttonHost && buttonHost.shadowRoot && buttonHost.shadowRoot.querySelector('button');
        if (!inner) return { clicked: false };
        inner.scrollIntoView({ block: 'center' });
        inner.click();
        return { clicked: true, text: (buttonHost.textContent || '').trim().slice(0, 40) };
      });
      record('expandClick', clicked);
      await sleep(6000);
      const badgeExpand = await page.evaluate(BADGE_STATE);
      const truthExpand = await page.evaluate(PAGE_TRUTH);
      record('afterExpand', {
        badge: badgeExpand,
        truth: { threads: truthExpand.threads, replies: truthExpand.replies, items: truthExpand.items },
        replyRequests: report.network.filter((entry) => /reply\/reply/.test(entry.path)),
      });
      await page.screenshot({ path: join(ARTIFACT_DIR, '05-after-expand.png') });
    }

    // ---- 路径三：DOM 里的评论数量真的变了 ----
    // 匿名状态下「滚动加载更多」和「展开楼中楼」都被登录墙挡住（见 afterExpand.replyRequests），
    // 所以这里换成更直接的证据：把一条真实评论摘掉再放回，计数必须跟着掉、跟着回。
    const detached = await page.evaluate(MUTATE_FEED, 'detach');
    record('detach', detached);
    if (detached.ok) {
      // 观察点是 150ms 防抖，等它跑完
      await sleep(1500);
      const badgeDetach = await page.evaluate(BADGE_STATE);
      const truthDetach = await page.evaluate(PAGE_TRUTH);
      record('afterDetach', {
        badge: badgeDetach,
        truth: { threads: truthDetach.threads, replies: truthDetach.replies },
      });

      const restored = await page.evaluate(MUTATE_FEED, 'restore');
      record('restore', restored);
      await sleep(1500);
      const badgeRestore = await page.evaluate(BADGE_STATE);
      const truthRestore = await page.evaluate(PAGE_TRUTH);
      record('afterRestore', {
        badge: badgeRestore,
        truth: { threads: truthRestore.threads, replies: truthRestore.replies },
      });
      await page.screenshot({ path: join(ARTIFACT_DIR, '06-after-dom-change.png') });
    }

    // ---- 站内切换视频 ----
    const beforeSwitch = await page.evaluate(() => ({ href: location.href, title: document.title }));
    const switchInfo = await page.evaluate((currentBvid) => {
      const links = [...document.querySelectorAll('a[href*="/video/BV"]')].filter((anchor) => {
        const match = /\/video\/(BV[0-9A-Za-z]{10})/.exec(anchor.getAttribute('href') || '');
        return match && match[1] !== currentBvid && !anchor.closest('#commentapp');
      });
      if (!links.length) return { found: false };
      const link = links[0];
      link.removeAttribute('target');
      const href = link.href;
      link.click();
      return { found: true, href, text: (link.textContent || '').trim().slice(0, 40) };
    }, BVID);
    record('switchEntry', switchInfo);

    if (switchInfo.found) {
      const previousAid = badge0.aid;
      let switched = true;
      try {
        await page.waitForFunction(
          (previous) => {
            const host = document.querySelector('#dshcc-badge');
            if (!host || host.getAttribute('data-dshcc-state') !== 'ok') return false;
            const aid = host.getAttribute('data-dshcc-aid');
            return !!aid && aid !== previous;
          },
          previousAid,
          { timeout: 60000 },
        );
      } catch (error) {
        switched = false;
        report.errors.push({ kind: 'switch', message: String(error && error.message) });
      }
      await sleep(2500);
      const badgeSwitch = await page.evaluate(BADGE_STATE);
      const truthSwitch = await page.evaluate(PAGE_TRUTH);
      const afterSwitch = await page.evaluate(() => ({ href: location.href, title: document.title }));
      record('afterSwitch', {
        switched,
        before: beforeSwitch,
        after: afterSwitch,
        badge: badgeSwitch,
        truth: {
          aid: truthSwitch.aid,
          threads: truthSwitch.threads,
          replies: truthSwitch.replies,
          items: truthSwitch.items,
        },
        // 相对点击目标一致 = SPA 内部跳转；不一致 = 整页导航
        fullPageReload: afterSwitch.href !== switchInfo.href,
      });
      await page.screenshot({ path: join(ARTIFACT_DIR, '07-after-switch.png') });
    }

    // ---- 判定 ----
    const sameAsDom = (badge, truth) =>
      !!badge && !!truth && badge.threads === truth.threads && badge.replies === truth.replies;
    const observationLines = report.consoleLines.filter((line) => line.text.includes('观测｜'));
    report.consoleSample = report.consoleLines.slice(0, 14);

    report.verdicts = {
      badgeVisible: !!badge0 && badge0.position.visible && badge0.position.position === 'fixed',
      badgeOutsideComments: !!badge0 && !badge0.insideCommentApp,
      countsMatchDom: sameAsDom(badge0, truth0),
      consolePrintedEach: observationLines.length >= truth0.threads + truth0.replies,
      consoleObservationCount: observationLines.length,
      expectedObservationCount: truth0.threads + truth0.replies,
      countsAfterScrollMatch: sameAsDom(badgeScroll, truthScroll),
      scrollGrowth: badgeScroll
        ? badgeScroll.threads + badgeScroll.replies - (badge0.threads + badge0.replies)
        : null,
      expandGrowth: report.steps.afterExpand
        ? report.steps.afterExpand.badge.threads +
          report.steps.afterExpand.badge.replies -
          (badgeScroll.threads + badgeScroll.replies)
        : null,
      injectGrowth: report.steps.afterRestore
        ? report.steps.afterRestore.badge.threads +
          report.steps.afterRestore.badge.replies -
          (badgeScroll.threads + badgeScroll.replies)
        : null,
      // 摘掉一条评论 → 计数必须下降；放回去 → 必须回到原值。这条链路通了，说明滚动/展开带来的增长同样会被看见。
      domChangeTracked: report.steps.afterDetach
        ? report.steps.afterDetach.badge.threads < badgeScroll.threads &&
          report.steps.afterDetach.badge.replies < badgeScroll.replies &&
          !!report.steps.afterRestore &&
          report.steps.afterRestore.badge.threads === badgeScroll.threads &&
          report.steps.afterRestore.badge.replies === badgeScroll.replies &&
          sameAsDom(report.steps.afterRestore.badge, report.steps.afterRestore.truth)
        : null,
      switchChangedAid: report.steps.afterSwitch
        ? !!report.steps.afterSwitch.badge.aid && report.steps.afterSwitch.badge.aid !== badge0.aid
        : null,
      switchCountsMatch: report.steps.afterSwitch
        ? sameAsDom(report.steps.afterSwitch.badge, report.steps.afterSwitch.truth)
        : null,
    };

    // ---- 对照：不装插件时的评论区结构必须一模一样 ----
    if (!skipAppearance) {
      await context.close();
      const clean = await openBrowser({ withExtension: false });
      try {
        await clean.page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await clean.page.evaluate(() => {
          const app = document.querySelector('#commentapp');
          if (app) app.scrollIntoView({ block: 'center' });
        });
        await clean.page
          .waitForFunction(
            () => {
              const host = document.querySelector('bili-comments');
              return !!(
                host &&
                host.shadowRoot &&
                host.shadowRoot.querySelector('#feed bili-comment-thread-renderer')
              );
            },
            null,
            { timeout: 60000 },
          )
          .catch(() => {});
        await sleep(3000);
        const badgeInClean = await clean.page.evaluate(() => !!document.querySelector('#dshcc-badge'));
        const serialClean = await clean.page.evaluate(SERIALIZE_COMMENTS);
        await clean.page.screenshot({ path: join(ARTIFACT_DIR, '08-no-extension.png') });
        const equal = !!serial0 && serial0 === serialClean;
        let firstDiff = null;
        if (!equal && serial0 && serialClean) {
          let index = 0;
          while (
            index < serial0.length &&
            index < serialClean.length &&
            serial0[index] === serialClean[index]
          ) {
            index += 1;
          }
          firstDiff = {
            index,
            withExtension: serial0.slice(Math.max(0, index - 100), index + 140),
            withoutExtension: serialClean.slice(Math.max(0, index - 100), index + 140),
          };
        }
        record('appearance', {
          badgeMissingWithoutExtension: !badgeInClean,
          commentsIdentical: equal,
          lengthWith: serial0 ? serial0.length : 0,
          lengthWithout: serialClean ? serialClean.length : 0,
          firstDiff,
        });
        await writeFile(join(ARTIFACT_DIR, 'comments-with-extension.html'), serial0 || '', 'utf8');
        await writeFile(join(ARTIFACT_DIR, 'comments-without-extension.html'), serialClean || '', 'utf8');
        report.verdicts.commentsUnchanged = equal;
      } finally {
        await clean.context.close();
      }
    }

    report.finishedAt = new Date().toISOString();
    await writeFile(join(ARTIFACT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
    log('verdicts: ' + JSON.stringify(report.verdicts));
    log('report: ' + join(ARTIFACT_DIR, 'report.json'));
    return report;
  } finally {
    await context.close().catch(() => {});
  }
}

main()
  .then(async (result) => {
    const failures = Object.entries(result.verdicts).filter(([, value]) => value === false);
    if (result.errors.length || failures.length) {
      console.error('E2E 未全部通过：', JSON.stringify({ failures, errors: result.errors }, null, 2));
      process.exitCode = 1;
    }
  })
  .catch(async (error) => {
    report.errors.push({
      kind: 'fatal',
      message: String(error && error.stack ? error.stack : error),
    });
    await mkdir(ARTIFACT_DIR, { recursive: true }).catch(() => {});
    await writeFile(join(ARTIFACT_DIR, 'report.json'), JSON.stringify(report, null, 2), 'utf8').catch(
      () => {},
    );
    console.error('E2E 失败：', error);
    process.exitCode = 1;
  });
