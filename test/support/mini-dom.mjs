// 测试用的极简 DOM：只为「解析保存下来的真实页面快照」服务。
//
// 真实快照把嵌套 shadow DOM 写成 <template shadowrootmode="open">，
// Node 没有 DOM，这里实现解析 + 最小查询能力，让页面适配层可以在离线、
// 无浏览器、零依赖的环境下对着真实结构跑测试。
//
// 支持的选择器子集（够用即可，遇到不支持的写法直接报错，避免夹具悄悄失配）：
//   tag、#id、[attr]、[attr="value"]、.class、tag#id，及后代组合（空格）。

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title']);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : match;
  });
}

class MiniNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }

  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }

  get children() {
    return this.childNodes.filter((node) => node.nodeType === 1);
  }

  get firstChild() {
    return this.childNodes[0] || null;
  }

  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }

  get firstElementChild() {
    return this.children[0] || null;
  }

  get nextSibling() {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return index === -1 ? null : this.parentNode.childNodes[index + 1] || null;
  }

  get ownerDocument() {
    let node = this;
    while (node) {
      if (node.nodeType === 9) return node;
      if (node.host) {
        node = node.host;
        continue;
      }
      node = node.parentNode;
    }
    return null;
  }

  get isConnected() {
    let node = this;
    while (node) {
      if (node.nodeType === 9) return true;
      node = node.host || node.parentNode;
    }
    return false;
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child, reference) {
    if (!reference) return this.appendChild(child);
    if (reference.parentNode !== this) throw new Error('参照节点不属于当前父节点');
    if (child.parentNode) child.parentNode.removeChild(child);
    const index = this.childNodes.indexOf(reference);
    child.parentNode = this;
    this.childNodes.splice(index, 0, child);
    return child;
  }

  removeChild(child) {
    const index = this.childNodes.indexOf(child);
    if (index === -1) throw new Error('要移除的节点不是当前节点的子节点');
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  replaceChild(next, previous) {
    this.insertBefore(next, previous);
    return this.removeChild(previous);
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }

  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentNode;
    }
    return false;
  }

  addEventListener(type, listener) {
    if (!this.listeners) this.listeners = new Map();
    const bucket = this.listeners.get(type) || [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type, listener) {
    const bucket = this.listeners && this.listeners.get(type);
    if (!bucket) return;
    const index = bucket.indexOf(listener);
    if (index !== -1) bucket.splice(index, 1);
  }

  dispatchEvent(event) {
    const target = event && event.target ? event.target : this;
    let stopped = false;
    const eventObject = {
      type: event && event.type ? event.type : String(event),
      target,
      currentTarget: this,
      // mouseleave/mouseover 等事件带 relatedTarget，真实浏览器里是「从哪个节点来/去哪个节点」；
      // 悬停交互的实现要靠它区分「移到按钮上」与「真的离开」。
      relatedTarget: event && event.relatedTarget ? event.relatedTarget : null,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
    };
    let node = this;
    while (node) {
      const bucket = node.listeners && node.listeners.get(eventObject.type);
      if (bucket) {
        for (const listener of bucket.slice()) listener.call(node, eventObject);
      }
      if (stopped) break;
      node = node.parentNode;
    }
    return !eventObject.defaultPrevented;
  }

  get textContent() {
    return this.childNodes.map((node) => node.textContent).join('');
  }

  set textContent(value) {
    this.childNodes = [];
    if (value !== '' && value != null) {
      this.appendChild(new MiniText(String(value)));
    }
  }

  // 只为测试 badge.mount 这类会写 innerHTML 的 UI 代码：用解析器建一棵子树，
  // 再把节点搬进当前节点。getter 不做完整序列化，返回空串避免误用。
  set innerHTML(value) {
    this.childNodes = [];
    const wrapper = parseHTML('<div>' + String(value == null ? '' : value) + '</div>').querySelector('div');
    if (!wrapper) return;
    for (const child of wrapper.childNodes.slice()) {
      this.appendChild(child);
    }
  }

  get innerHTML() {
    return '';
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    if (!parts.length || parts.some((part) => !part)) {
      throw new Error(`空选择器：${JSON.stringify(selector)}`);
    }
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (matchesChain(child, parts)) {
          matches.push(child);
        }
        visit(child);
      }
    };
    visit(this);
    return matches;
  }
}

class MiniText extends MiniNode {
  constructor(data) {
    super(3);
    this.data = data;
  }

  get textContent() {
    return this.data;
  }

  set textContent(value) {
    this.data = String(value);
  }
}

class MiniElement extends MiniNode {
  constructor(tagName) {
    super(1);
    this.localName = tagName.toLowerCase();
    this.tagName = this.localName.toUpperCase();
    this.attributes = new Map();
    this.shadowRoot = null;
  }

  get id() {
    return this.getAttribute('id') || '';
  }

  get className() {
    return this.getAttribute('class') || '';
  }

  getAttribute(name) {
    const value = this.attributes.get(name.toLowerCase());
    return value === undefined ? null : value;
  }

  hasAttribute(name) {
    return this.attributes.has(name.toLowerCase());
  }

  setAttribute(name, value) {
    this.attributes.set(name.toLowerCase(), String(value));
  }

  removeAttribute(name) {
    this.attributes.delete(name.toLowerCase());
  }

  get hidden() {
    return this.hasAttribute('hidden');
  }

  set hidden(value) {
    if (value) this.setAttribute('hidden', '');
    else this.removeAttribute('hidden');
  }

  attachShadow(options) {
    const shadow = new MiniShadowRoot(this);
    shadow.mode = options && options.mode ? options.mode : 'open';
    this.shadowRoot = shadow;
    return shadow;
  }

  closest(selector) {
    let node = this;
    while (node && node.nodeType === 1) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }

  click() {
    this.dispatchEvent({ type: 'click', target: this });
  }

  matches(selector) {
    return matchesChain(this, selector.trim().split(/\s+/));
  }

  // 真实 DOM 里 textContent 不包含 shadow root 的内容，这里保持一致。
  get textContent() {
    return super.textContent;
  }

  set textContent(value) {
    super.textContent = value;
  }
}

class MiniShadowRoot extends MiniNode {
  constructor(host) {
    super(11);
    this.host = host;
  }
}

class MiniDocument extends MiniNode {
  constructor() {
    super(9);
  }

  get documentElement() {
    return this.children[0] || null;
  }

  get body() {
    return this.querySelector('body');
  }

  createElement(tagName) {
    return new MiniElement(tagName);
  }

  createTextNode(text) {
    return new MiniText(String(text));
  }
}

// 属性选择器必须优先匹配：否则 `[rel="canonical"]` 里的 `[` 会被当成前缀、
// 值里残留的 `]` 又无人消费，整个片段解析失败。
const COMPOUND_TOKEN = /\[([^\]]+)\]|([#.])([^\s#.\[\]]+)/g;

function parseCompound(compound) {
  if (compound === '*') {
    return { tag: null, matchers: [] };
  }
  const result = { tag: null, matchers: [] };
  const text = compound.trim();
  if (!text) {
    throw new Error('空的选择器片段');
  }
  if (text.includes(':') || text.includes('>') || text.includes('+') || text.includes('~')) {
    throw new Error(`mini-dom 不支持该选择器写法：${compound}`);
  }

  let rest = text;
  const tagMatch = /^([a-zA-Z][\w-]*)/.exec(rest);
  if (tagMatch) {
    result.tag = tagMatch[1].toLowerCase();
    rest = rest.slice(tagMatch[1].length);
  }

  COMPOUND_TOKEN.lastIndex = 0;
  let consumed = 0;
  let match;
  while ((match = COMPOUND_TOKEN.exec(rest)) !== null) {
    if (match.index !== consumed) {
      throw new Error(`mini-dom 无法解析选择器：${compound}`);
    }
    consumed = match.index + match[0].length;
    const prefix = match[2];
    const token = match[3];
    if (match[1] !== undefined) {
      const attr = match[1];
      const eq = attr.indexOf('=');
      if (eq === -1) {
        result.matchers.push((el) => el.hasAttribute(attr.trim()));
      } else {
        const name = attr.slice(0, eq).trim();
        const rawValue = attr.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        result.matchers.push((el) => el.getAttribute(name) === rawValue);
      }
    } else if (prefix === '#') {
      result.matchers.push((el) => el.getAttribute('id') === token);
    } else if (prefix === '.') {
      result.matchers.push((el) => (el.getAttribute('class') || '').split(/\s+/).includes(token));
    } else {
      throw new Error(`mini-dom 无法解析选择器：${compound}`);
    }
  }
  if (consumed !== rest.length) {
    throw new Error(`mini-dom 无法解析选择器：${compound}`);
  }
  return result;
}

const compoundCache = new Map();

function getCompound(compound) {
  if (!compoundCache.has(compound)) {
    compoundCache.set(compound, parseCompound(compound));
  }
  return compoundCache.get(compound);
}

function matchesCompound(el, compound) {
  const parsed = getCompound(compound);
  if (parsed.tag && el.localName !== parsed.tag) {
    return false;
  }
  return parsed.matchers.every((matcher) => matcher(el));
}

function matchesChain(el, parts) {
  if (!matchesCompound(el, parts[parts.length - 1])) {
    return false;
  }
  let index = parts.length - 2;
  let ancestor = el.parentElement;
  while (index >= 0) {
    if (!ancestor) {
      return false;
    }
    if (matchesCompound(ancestor, parts[index])) {
      index -= 1;
    }
    ancestor = ancestor.parentElement;
  }
  return true;
}

function parseAttributes(source) {
  const attributes = new Map();
  const pattern = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes.set(name, decodeEntities(value));
  }
  return attributes;
}

export function parseHTML(html) {
  const source = String(html).replace(/<!--[\s\S]*?-->/g, '');
  const document = new MiniDocument();
  const stack = [{ container: document, tag: null }];

  let index = 0;
  while (index < source.length) {
    const lt = source.indexOf('<', index);
    if (lt === -1) {
      appendText(source.slice(index));
      break;
    }
    if (lt > index) {
      appendText(source.slice(index, lt));
    }
    if (source.startsWith('<!', lt)) {
      const end = source.indexOf('>', lt);
      index = end === -1 ? source.length : end + 1;
      continue;
    }

    const closing = source.startsWith('</', lt);
    const nameMatch = /^<\/?([a-zA-Z][\w-]*)/.exec(source.slice(lt, lt + 64));
    if (!nameMatch) {
      appendText('<');
      index = lt + 1;
      continue;
    }
    const tag = nameMatch[1].toLowerCase();
    const tagEnd = findTagEnd(source, lt);
    if (tagEnd === -1) {
      appendText(source.slice(lt));
      break;
    }

    if (closing) {
      closeElement(tag);
      index = tagEnd + 1;
      continue;
    }

    const attributeSource = source.slice(lt + nameMatch[0].length, tagEnd);
    const attributes = parseAttributes(attributeSource);
    const selfClosing = /\/\s*$/.test(attributeSource);

    if (tag === 'template' && attributes.get('shadowrootmode')) {
      const host = stack[stack.length - 1].container;
      stack.push({ container: new MiniShadowRoot(host), tag, shadowFor: host });
      index = tagEnd + 1;
      continue;
    }

    const element = new MiniElement(tag);
    element.attributes = attributes;
    stack[stack.length - 1].container.appendChild(element);
    index = tagEnd + 1;

    if (VOID_ELEMENTS.has(tag) || selfClosing) {
      continue;
    }
    if (RAW_TEXT_ELEMENTS.has(tag)) {
      const closePattern = new RegExp(`</${tag}\\s*>`, 'i');
      const rest = source.slice(index);
      const found = closePattern.exec(rest);
      const rawEnd = found ? index + found.index : source.length;
      const rawText = source.slice(index, rawEnd);
      if (rawText) {
        element.appendChild(new MiniText(decodeEntities(rawText)));
      }
      index = found ? rawEnd + found[0].length : source.length;
      continue;
    }
    stack.push({ container: element, tag });
  }

  return document;

  function appendText(text) {
    if (!text) {
      return;
    }
    stack[stack.length - 1].container.appendChild(new MiniText(decodeEntities(text)));
  }

  function closeElement(tag) {
    let position = stack.length - 1;
    while (position > 0 && stack[position].tag !== tag) {
      position -= 1;
    }
    if (position === 0) {
      return; // 没有匹配的开标签（例如快照里的 </img>），忽略
    }
    while (stack.length - 1 > position) {
      abandonTop();
    }
    abandonTop();
  }

  function abandonTop() {
    const top = stack.pop();
    if (top.shadowFor) {
      top.shadowFor.shadowRoot = top.container;
    }
  }
}

function findTagEnd(source, start) {
  let quote = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === quote) {
        quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}
