// 资料读取：把「该不该读」变成「读一次、缓存、失败降级」。
// 与 profile-need.js 分工：那边决定要不要读，这边只负责读的纪律。
// 隐私边界：只取卡片里的 sign 一个字段；缓存只落 {sign, at}，不落昵称、头像、等级、关注关系。
// 只读：只有 GET，没有点赞/关注/评论，没有翻页，不批量抓评论。
// 依赖全部注入（request / 存储 / 时钟），本文件不发真实请求、不取当前时间。
import { needsProfile } from './profile-need.js';

/** 站点公开资料接口：只读作者卡片，签名示例见 README「观测契约」的 bio 形态。 */
export const PROFILE_ENDPOINT = 'https://api.bilibili.com/x/space/acc/info';
/** 缓存有效期：7 天。简介变化很慢，过期后自然重读，不需要主动失效。 */
export const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 缓存条数上限：超出后按写入时间清最旧的，避免无限增长。 */
export const PROFILE_CACHE_LIMIT = 50;
/** 相邻两次请求的最小间隔，避免连点页面时并发轰炸站点。 */
export const PROFILE_MIN_INTERVAL_MS = 800;
/** 单次请求超时。超时与失败同等待遇：当作没有这条证据。 */
export const PROFILE_TIMEOUT_MS = 3000;

const TIMEOUT = Symbol('timeout');

function normalizeSign(value) {
  return typeof value === 'string' ? value : null;
}

/**
 * 本机简介缓存。存储以「整块 JSON」注入，扩展侧接 chrome.storage.local，测试侧接内存假存储。
 * 只接受 {load, save} 两个异步函数，其余一律自己管（TTL、条数上限、清理）。
 *
 * @param {{load: () => any, save: (entries: object) => any, now?: () => number, ttlMs?: number, limit?: number}} options
 */
export function createProfileCache(options = {}) {
  const { load, save, now = () => Date.now(), ttlMs = PROFILE_TTL_MS, limit = PROFILE_CACHE_LIMIT } = options;
  if (typeof load !== 'function' || typeof save !== 'function') {
    throw new TypeError('createProfileCache 需要 load/save 两个存储函数');
  }
  if (!(limit >= 1)) throw new TypeError('缓存条数上限必须是正整数');

  async function readAll() {
    const raw = await load();
    return raw && typeof raw === 'object' ? { ...raw } : {};
  }

  function fresh(entry) {
    return !!entry && Number.isFinite(entry.at) && now() - entry.at < ttlMs;
  }

  return {
    /** 命中返回观测可直接用的 bio；未命中/过期返回 null，过期条目顺手清掉。 */
    async get(mid) {
      const key = String(mid);
      const all = await readAll();
      const entry = all[key];
      if (!entry) return null;
      if (!fresh(entry) || normalizeSign(entry.sign) === null) {
        delete all[key];
        await save(all);
        return null;
      }
      return { status: 'ok', value: entry.sign };
    },
    /** 只写 {sign, at}；空简介没有复用价值，不落盘。 */
    async set(mid, sign) {
      const key = String(mid);
      const value = normalizeSign(sign);
      if (value === null || !value.trim()) return;
      const all = await readAll();
      all[key] = { sign: value, at: now() };
      const kept = Object.entries(all)
        .filter(([, entry]) => fresh(entry) && normalizeSign(entry.sign) !== null)
        .sort((a, b) => a[1].at - b[1].at)
        .slice(-limit);
      await save(Object.fromEntries(kept));
    },
    /** 当前条目数（诊断/测试用）。 */
    async size() {
      const all = await readAll();
      return Object.values(all).filter(fresh).length;
    },
  };
}

/**
 * 按需读取器：一次页面会话一份，读到的结果复用同一份缓存。
 *
 * @param {object} options
 * @param {(url: string, init: {method: string, signal?: AbortSignal}) => Promise<{ok: boolean, status?: number, json: () => Promise<any>}>} options.request
 * @param {{get: Function, set: Function}} [options.cache] 缺省时不缓存（每次会话各读一次）
 * @param {() => number} [options.now]
 * @param {number} [options.minIntervalMs]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.endpoint]
 */
export function createProfileReader(options = {}) {
  const {
    request,
    cache = null,
    now = () => Date.now(),
    minIntervalMs = PROFILE_MIN_INTERVAL_MS,
    timeoutMs = PROFILE_TIMEOUT_MS,
    endpoint = PROFILE_ENDPOINT,
  } = options;
  if (typeof request !== 'function') throw new TypeError('createProfileReader 需要 request 函数');

  // 本次页面会话内已经读过的作者：同一作者只读一次（含失败，避免重试风暴）。
  const seen = new Set();
  let lastStartedAt = -Infinity;
  let tail = Promise.resolve();

  async function once(mid) {
    const url = `${endpoint}?mid=${encodeURIComponent(mid)}`;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    });
    const call = Promise.resolve().then(() =>
      request(url, { method: 'GET', signal: controller ? controller.signal : undefined }),
    );
    call.catch(() => {}); // 超时/中断竞速后不再需要这次的结果，避免未处理拒绝
    try {
      const res = await Promise.race([call, timeout]);
      if (res === TIMEOUT || !res || res.ok === false) return null;
      const payload = await res.json();
      // 只读 sign：卡片里其余的字段一律不碰。
      return normalizeSign(payload && payload.data && payload.data.card && payload.data.card.sign);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      if (controller) controller.abort();
    }
  }

  /** 串行排队 + 最小间隔：并发调用会被顺延，不会同时打到站点。 */
  function schedule(task) {
    const run = async () => {
      const wait = minIntervalMs - (now() - lastStartedAt);
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      lastStartedAt = now();
      return task();
    };
    const result = tail.then(run, run);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  return {
    /**
     * 该读才读：无线索返回 null（不发请求）；命中缓存直接给证据；
     * 失败/超时/缺字段返回 {status:'failed'}，既不加线索也不减线索。
     *
     * @param {object} observation 页面可得观测（bio 可为空）
     * @param {object} [pageContext] 当前页上下文
     * @returns {Promise<{status:'ok', value:string}|{status:'failed'}|null>}
     */
    async read(observation, pageContext) {
      const mid =
        observation && observation.authorMid != null ? String(observation.authorMid).trim() : '';
      if (!mid) return null;
      if (!needsProfile(observation, pageContext).needed) return null;

      if (cache) {
        const cached = await cache.get(mid);
        if (cached) return cached;
      }
      if (seen.has(mid)) return null;
      seen.add(mid);

      const sign = await schedule(() => once(mid));
      if (sign === null) return { status: 'failed' };
      if (cache) await cache.set(mid, sign);
      return { status: 'ok', value: sign };
    },
  };
}
