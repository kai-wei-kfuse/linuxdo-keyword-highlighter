// ==UserScript==
// @name         Linux.do 荧光关键词高亮
// @namespace    linuxdo-keyword-highlighter
// @version      1.0.0
// @description  分区关键词高亮、荧光背景与阴影、短词覆盖长词、可拖动或贴边的设置入口。
// @match        https://linux.do/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// ==/UserScript==

(() => {
  'use strict';

  const STORAGE_KEY = 'linuxdo-keyword-highlighter-v1';
  const SCOPES = ['list', 'topic', 'body'];
  const REGIONS = [
    { scope: 'list', label: '列表标题', selector: '.topic-list .topic-list-item a.title' },
    { scope: 'topic', label: '帖子页标题', selector: 'h1 a.fancy-title' },
    { scope: 'body', label: '正文与回复', selector: '.topic-body .cooked' },
  ];
  const REGION_SELECTOR = REGIONS.map(region => region.selector).join(',');
  const PALETTE = ['#18f0ff', '#edff00', '#ff5cc9', '#83ff38', '#ff913b'];
  const INITIAL_SETTINGS = {
    version: 1,
    rules: [],
    ui: { mode: 'right', position: { x: 0.94, y: 0.72 } },
  };
  const BLOCK_TAGS = new Set([
    'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT',
    'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION',
    'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
  ]);
  const SKIP_SELECTOR = [
    'script', 'style', 'textarea', 'input', 'select', 'button', 'svg', 'canvas',
    'iframe', 'object', 'audio', 'video', '[contenteditable]:not([contenteditable="false"])',
    '[data-ldkh-owned]',
  ].join(',');

  function validateSettings(settings) {
    const fail = field => { throw new TypeError(`关键词高亮设置格式错误：${field}`); };
    if (!settings || settings.version !== 1) fail('version');
    if (!Array.isArray(settings.rules)) fail('rules');
    const ids = new Set();
    for (const [index, rule] of settings.rules.entries()) {
      if (!rule || typeof rule.id !== 'string' || !/^[a-z0-9-]+$/.test(rule.id) || ids.has(rule.id)) fail(`rules[${index}].id`);
      ids.add(rule.id);
      if (typeof rule.text !== 'string') fail(`rules[${index}].text`);
      if (typeof rule.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(rule.color)) fail(`rules[${index}].color`);
      if (typeof rule.enabled !== 'boolean') fail(`rules[${index}].enabled`);
      if (!Array.isArray(rule.scopes) || rule.scopes.some(scope => !SCOPES.includes(scope)) || new Set(rule.scopes).size !== rule.scopes.length) fail(`rules[${index}].scopes`);
    }
    if (!settings.ui || !['left', 'right', 'floating'].includes(settings.ui.mode)) fail('ui.mode');
    for (const axis of ['x', 'y']) {
      const value = settings.ui.position?.[axis];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(`ui.position.${axis}`);
    }
    return settings;
  }

  function compileRules(rules, scope) {
    return rules.flatMap((rule, order) => {
      if (!rule.enabled || !rule.scopes.includes(scope) || rule.text.length === 0) return [];
      const literal = rule.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return [{
        ...rule,
        order,
        length: Array.from(rule.text).length,
        // Lookahead includes overlapping occurrences without changing original text offsets.
        pattern: new RegExp(`(?=(${literal}))`, 'giu'),
      }];
    });
  }

  function findSegments(text, rules) {
    const events = [];
    for (const rule of rules) {
      for (const match of text.matchAll(rule.pattern)) {
        events.push({ at: match.index, delta: 1, rule });
        events.push({ at: match.index + match[1].length, delta: -1, rule });
      }
    }
    events.sort((a, b) => a.at - b.at);
    const active = new Map();
    const segments = [];
    let previous = 0;
    let index = 0;

    while (index < events.length) {
      const at = events[index].at;
      const winner = [...active.values()].reduce((best, item) => {
        if (!best || item.rule.length < best.length || (item.rule.length === best.length && item.rule.order < best.order)) return item.rule;
        return best;
      }, null);
      if (winner && at > previous) {
        const last = segments[segments.length - 1];
        if (last && last.end === previous && last.ruleId === winner.id) last.end = at;
        else segments.push({ start: previous, end: at, ruleId: winner.id });
      }
      while (index < events.length && events[index].at === at) {
        const event = events[index++];
        const count = (active.get(event.rule.id)?.count || 0) + event.delta;
        if (count === 0) active.delete(event.rule.id);
        else active.set(event.rule.id, { rule: event.rule, count });
      }
      previous = at;
    }
    return segments;
  }

  function contrastText(hex) {
    const channels = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? '#000000' : '#ffffff';
  }

  function mergeRects(rectangles) {
    const result = [];
    for (const rect of rectangles) {
      let merged = { ...rect };
      let index = 0;
      while (index < result.length) {
        const other = result[index];
        if (merged.left <= other.right && merged.right >= other.left && merged.top < other.bottom && merged.bottom > other.top) {
          merged = {
            left: Math.min(merged.left, other.left), right: Math.max(merged.right, other.right),
            top: Math.min(merged.top, other.top), bottom: Math.max(merged.bottom, other.bottom),
          };
          result.splice(index, 1);
          index = 0;
        } else index++;
      }
      result.push(merged);
    }
    return result;
  }

  const core = { validateSettings, compileRules, findSegments, contrastText, mergeRects };
  if (typeof window === 'undefined' && typeof module === 'object' && module.exports) {
    module.exports = core;
    return;
  }

  function collectRuns(root) {
    const runs = [];
    let nodes = [];
    let parts = [];
    let length = 0;
    function flush() {
      if (length) runs.push({ text: parts.join(''), nodes });
      nodes = [];
      parts = [];
      length = 0;
    }
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (node.data.length) {
          nodes.push({ node, start: length, end: length + node.data.length });
          parts.push(node.data);
          length += node.data.length;
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.matches(SKIP_SELECTOR) || node.tagName === 'BR') {
        flush();
        return;
      }
      const block = BLOCK_TAGS.has(node.tagName);
      if (block) flush();
      for (const child of node.childNodes) visit(child);
      if (block) flush();
    }
    visit(root);
    flush();
    return runs;
  }

  function rangeForSegment(run, segment) {
    const first = run.nodes.find(item => item.end > segment.start);
    const last = run.nodes.find(item => item.end >= segment.end);
    const range = document.createRange();
    range.setStart(first.node, segment.start - first.start);
    range.setEnd(last.node, segment.end - last.start);
    return range;
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function createView() {
    const host = createElement('div');
    host.dataset.ldkhOwned = 'ui';
    host.id = 'ldkh-settings';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = createElement('style');
    style.textContent = `
      :host { color-scheme: light dark; font: 14px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
      *, *::before, *::after { box-sizing: border-box; }
      [hidden] { display: none !important; }
      button, input, select { font: inherit; }
      button, select, input[type="checkbox"], input[type="color"] { cursor: pointer; }
      button { border: 1px solid light-dark(#d9dee7, #4b515c); border-radius: 8px; padding: 6px 12px; color: light-dark(#1f2933, #e7ecf3); background: light-dark(#fff, #282d36); }
      button:hover { background: light-dark(#f1f4f7, #353b46); }
      .entry { position: fixed; z-index: 2147483647; margin: 0; border: 0; background: #edff00; color: #16212b; box-shadow: 0 2px 6px rgb(0 0 0 / 25%); user-select: none; touch-action: none; }
      .entry:hover { background: #dfff00; }
      .entry[data-mode="left"], .entry[data-mode="right"] { top: 50%; transform: translateY(-50%); writing-mode: vertical-rl; width: 30px; height: 78px; padding: 12px 6px; }
      .entry[data-mode="left"] { left: 0; right: auto; border-radius: 0 8px 8px 0; }
      .entry[data-mode="right"] { right: 0; left: auto; border-radius: 8px 0 0 8px; }
      .entry[data-mode="floating"] { width: 52px; height: 44px; padding: 0; border-radius: 9px; cursor: move; }
      dialog { width: min(700px, calc(100vw - 48px)); max-height: calc(100dvh - 48px); padding: 0; border: 1px solid light-dark(#dce1e8, #404855); border-radius: 14px; background: light-dark(#fff, #1e232b); color: light-dark(#202936, #e6edf6); box-shadow: 0 16px 64px rgb(0 0 0 / 28%); }
      dialog::backdrop { background: rgb(0 0 0 / 35%); }
      .header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 18px 20px; border-bottom: 1px solid light-dark(#e6eaf0, #353e4c); }
      .heading { font-size: 18px; font-weight: 600; margin: 0; }
      .hint { font-size: 12px; color: light-dark(#5e6a79, #aebbd0); margin: 3px 0 0; }
      .content { padding: 18px 20px 22px; }
      .toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 18px; }
      .toolbar label { display: flex; align-items: center; gap: 8px; }
      select, input[type="text"] { color: inherit; background: light-dark(#fff, #282f3a); border: 1px solid light-dark(#cfd7e2, #4a5669); border-radius: 7px; padding: 7px 9px; }
      .add { margin-left: auto; background: #edff00; color: #16212b; border-color: transparent; }
      .add:hover { background: #dfff00; }
      .rules { display: flex; flex-direction: column; gap: 12px; }
      .rule { padding: 13px; border: 1px solid light-dark(#e0e6ee, #414b5b); border-radius: 9px; }
      .rule-main { display: flex; align-items: center; gap: 9px; }
      .text { min-width: 0; flex: 1; }
      .color { flex: 0 0 auto; width: 36px; height: 34px; padding: 2px; background: transparent; border: 1px solid light-dark(#cfd7e2, #4a5669); border-radius: 7px; }
      .remove { flex: 0 0 auto; padding: 5px 9px; }
      .rule-scopes { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; margin-top: 10px; }
      .check { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
      input[type="checkbox"] { accent-color: light-dark(#35455f, #b9c9e0); margin: 0; width: 15px; height: 15px; }
      .rule-status { color: light-dark(#66758a, #aebbd0); font-size: 12px; }
      .empty { margin: 24px 0; text-align: center; color: light-dark(#66758a, #aebbd0); }
      .error { color: light-dark(#b42318, #ffb4ac); background: light-dark(#fff0ef, #462c2c); border-radius: 7px; padding: 10px 12px; margin-bottom: 14px; overflow-wrap: anywhere; }
      .footer { margin: 16px 0 0; color: light-dark(#66758a, #aebbd0); font-size: 12px; }
      @media (max-width: 500px) { .header, .content { padding: 14px; } .rule-main { flex-wrap: wrap; } .text { flex-basis: calc(100% - 80px); } .add { margin-left: 0; } }
    `;
    const entry = createElement('button', 'entry', '高亮');
    entry.type = 'button';
    entry.setAttribute('aria-label', '打开关键词高亮设置');
    const dialog = createElement('dialog');
    dialog.setAttribute('aria-label', '关键词高亮设置');
    const header = createElement('div', 'header');
    const heading = createElement('div');
    heading.append(createElement('h2', 'heading', '关键词高亮'), createElement('p', 'hint', '荧光背景 · 阴影 · 短词覆盖长词'));
    const close = createElement('button', '', '关闭');
    close.type = 'button';
    header.append(heading, close);
    const content = createElement('div', 'content');
    const error = createElement('div', 'error');
    error.hidden = true;
    error.setAttribute('role', 'alert');
    const toolbar = createElement('div', 'toolbar');
    const modeLabel = createElement('label', '', '设置入口');
    const mode = createElement('select');
    mode.setAttribute('aria-label', '设置入口位置');
    for (const [value, label] of [['left', '左侧贴边'], ['right', '右侧贴边'], ['floating', '可拖动浮窗']]) {
      const option = createElement('option', '', label);
      option.value = value;
      mode.append(option);
    }
    modeLabel.append(mode);
    const add = createElement('button', 'add', '添加关键词');
    add.type = 'button';
    toolbar.append(modeLabel, add);
    const ruleList = createElement('div', 'rules');
    const empty = createElement('p', 'empty', '还没有关键词，点击「添加关键词」开始设置。');
    const footer = createElement('p', 'footer', '修改立即保存并生效。包含匹配，忽略大小写；代码也高亮。关键词留空或未勾选区域时不生效。');
    content.append(error, toolbar, empty, ruleList, footer);
    dialog.append(header, content);
    shadow.append(style, entry, dialog);
    document.body.append(host);
    function open() {
      if (!dialog.open) dialog.showModal();
      entry.style.visibility = 'hidden';
    }
    function report(errorValue) {
      error.textContent = errorValue.message;
      error.hidden = false;
      open();
    }
    close.addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { entry.style.visibility = ''; });
    return { host, shadow, entry, dialog, mode, add, ruleList, empty, error, open, report };
  }

  function createPainter() {
    const names = new Set();
    const css = createElement('style');
    css.dataset.ldkhOwned = 'highlight-styles';
    document.head.append(css);
    const host = createElement('div');
    host.dataset.ldkhOwned = 'shadows';
    host.id = 'ldkh-shadows';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = createElement('style');
    // A document layer beneath site menus keeps decorative shadows from covering navigation.
    style.textContent = `
      :host { position: fixed; inset: 0; pointer-events: none; z-index: 1; overflow: hidden; }
      .shadow { position: absolute; background: transparent; box-shadow: 0 2px 3px rgb(0 0 0 / 28%), 0 0 5px color-mix(in srgb, var(--color) 35%, transparent); }
    `;
    const layer = createElement('div');
    layer.setAttribute('aria-hidden', 'true');
    shadow.append(style, layer);
    document.body.append(host);

    function paintHighlights(roots, rules) {
      const grouped = new Map(rules.map(rule => [rule.id, []]));
      for (const data of roots.values()) {
        for (const item of data.ranges) grouped.get(item.ruleId).push(item.range);
      }
      for (const name of names) CSS.highlights.delete(name);
      names.clear();
      const declarations = [];
      for (const rule of rules) {
        const ranges = grouped.get(rule.id);
        if (!ranges.length) continue;
        const name = `ldkh-${rule.id}`;
        const highlight = new Highlight();
        for (const range of ranges) highlight.add(range);
        CSS.highlights.set(name, highlight);
        names.add(name);
        declarations.push(`::highlight(${name}) { background-color: ${rule.color}; color: ${contrastText(rule.color)}; }`);
      }
      css.textContent = declarations.join('\n');
    }

    function clipBox(root) {
      const clip = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      for (let element = root; element; element = element.parentElement) {
        const styleValue = getComputedStyle(element);
        const clipsX = ['hidden', 'clip', 'scroll', 'auto'].includes(styleValue.overflowX);
        const clipsY = ['hidden', 'clip', 'scroll', 'auto'].includes(styleValue.overflowY);
        if (!clipsX && !clipsY) continue;
        const rect = element.getBoundingClientRect();
        const left = rect.left + element.clientLeft;
        const top = rect.top + element.clientTop;
        if (clipsX) { clip.left = Math.max(clip.left, left); clip.right = Math.min(clip.right, left + element.clientWidth); }
        if (clipsY) { clip.top = Math.max(clip.top, top); clip.bottom = Math.min(clip.bottom, top + element.clientHeight); }
      }
      return clip;
    }

    function paintShadows(roots, rules) {
      const colors = new Map(rules.map(rule => [rule.id, rule.color]));
      const boxes = [];
      for (const data of roots.values()) {
        for (const item of data.ranges) {
          const ancestor = item.range.commonAncestorContainer;
          const clip = clipBox(ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement);
          const rects = [...item.range.getClientRects()].map(rect => ({
            left: Math.max(rect.left, clip.left), right: Math.min(rect.right, clip.right),
            top: Math.max(rect.top, clip.top), bottom: Math.min(rect.bottom, clip.bottom),
          })).filter(rect => rect.right > rect.left && rect.bottom > rect.top);
          for (const rect of mergeRects(rects)) boxes.push({ ...rect, color: colors.get(item.ruleId) });
        }
      }
      const fragment = document.createDocumentFragment();
      for (const box of boxes) {
        const element = createElement('div', 'shadow');
        element.style.left = `${box.left}px`;
        element.style.top = `${box.top}px`;
        element.style.width = `${box.right - box.left}px`;
        element.style.height = `${box.bottom - box.top}px`;
        element.style.setProperty('--color', box.color);
        fragment.append(element);
      }
      layer.replaceChildren(fragment);
    }
    return { paintHighlights, paintShadows };
  }

  function createHighlighter(painter) {
    const roots = new Map();
    const dirty = new Set();
    let compiled = new Map();
    let rules = [];
    let frame = null;
    let rescan = true;
    let recolor = false;
    const sizes = new ResizeObserver(() => schedule());

    function discover() {
      for (const [root, data] of roots) {
        const region = REGIONS.find(item => root.matches(item.selector));
        if (!root.isConnected || !region) {
          roots.delete(root);
          sizes.unobserve(root);
          recolor = true;
        } else if (data.scope !== region.scope) {
          data.scope = region.scope;
          dirty.add(root);
        }
      }
      for (const region of REGIONS) {
        for (const root of document.querySelectorAll(region.selector)) {
          if (roots.has(root)) continue;
          roots.set(root, { scope: region.scope, ranges: [] });
          sizes.observe(root);
          dirty.add(root);
        }
      }
      rescan = false;
    }

    function flush() {
      frame = null;
      if (rescan) discover();
      for (const root of dirty) {
        const data = roots.get(root);
        if (!data) continue;
        data.ranges = collectRuns(root).flatMap(run => findSegments(run.text, compiled.get(data.scope)).map(segment => ({
          range: rangeForSegment(run, segment), ruleId: segment.ruleId,
        })));
        recolor = true;
      }
      dirty.clear();
      if (recolor) { painter.paintHighlights(roots, rules); recolor = false; }
      painter.paintShadows(roots, rules);
    }

    function schedule() {
      if (frame === null) frame = requestAnimationFrame(flush);
    }

    function update(nextRules) {
      rules = nextRules;
      compiled = new Map(SCOPES.map(scope => [scope, compileRules(rules, scope)]));
      for (const root of roots.keys()) dirty.add(root);
      recolor = true;
      rescan = true;
      schedule();
    }

    const mutations = new MutationObserver(records => {
      let changed = false;
      for (const record of records) {
        const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (!target || target.closest('[data-ldkh-owned]')) continue;
        const root = target.closest(REGION_SELECTOR);
        if (root) { dirty.add(root); changed = true; }
        if (record.type !== 'characterData') { rescan = true; changed = true; }
      }
      if (changed) schedule();
    });
    mutations.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class', 'contenteditable'] });
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    window.addEventListener('resize', schedule);
    document.fonts.addEventListener('loadingdone', schedule);
    return { update, schedule };
  }

  function createRuleCard(rule, onChange, onRemove) {
    const card = createElement('div', 'rule');
    card.dataset.ruleId = rule.id;
    const main = createElement('div', 'rule-main');
    const text = createElement('input', 'text');
    text.type = 'text';
    text.value = rule.text;
    text.placeholder = '输入关键词';
    text.setAttribute('aria-label', '关键词');
    const color = createElement('input', 'color');
    color.type = 'color';
    color.value = rule.color;
    color.setAttribute('aria-label', '关键词背景色');
    const remove = createElement('button', 'remove', '删除');
    remove.type = 'button';
    const scopes = createElement('div', 'rule-scopes');
    const status = createElement('span', 'rule-status');
    const checks = new Map();
    function check(labelText, checked) {
      const label = createElement('label', 'check');
      const input = createElement('input');
      input.type = 'checkbox';
      input.checked = checked;
      label.append(input, document.createTextNode(labelText));
      scopes.append(label);
      return input;
    }
    const enabled = check('启用', rule.enabled);
    for (const region of REGIONS) checks.set(region.scope, check(region.label, rule.scopes.includes(region.scope)));
    function refreshStatus() {
      status.textContent = !text.value.length ? '未填写关键词' : !enabled.checked ? '已暂停' : ![...checks.values()].some(input => input.checked) ? '未选择区域' : '';
    }
    function change() {
      refreshStatus();
      onChange({ text: text.value, color: color.value, enabled: enabled.checked, scopes: [...checks].filter(([, input]) => input.checked).map(([scope]) => scope) });
    }
    text.addEventListener('input', change);
    color.addEventListener('input', change);
    enabled.addEventListener('change', change);
    for (const input of checks.values()) input.addEventListener('change', change);
    remove.addEventListener('click', onRemove);
    main.append(text, color, remove);
    scopes.append(status);
    card.append(main, scopes);
    refreshStatus();
    return { card, text };
  }

  function positionEntry(view, ui) {
    const entry = view.entry;
    entry.dataset.mode = ui.mode;
    view.mode.value = ui.mode;
    entry.style.left = '';
    entry.style.top = '';
    if (ui.mode !== 'floating') return;
    // Ratios use the available viewport so a saved button stays reachable after resize.
    const availableX = Math.max(0, window.innerWidth - entry.offsetWidth);
    const availableY = Math.max(0, window.innerHeight - entry.offsetHeight);
    entry.style.left = `${availableX * ui.position.x}px`;
    entry.style.top = `${availableY * ui.position.y}px`;
  }

  function attachDragging(view, readSettings, saveSettings) {
    const entry = view.entry;
    const DRAG_START_DISTANCE = 4;
    let drag = null;
    let suppressClick = false;
    entry.addEventListener('pointerdown', event => {
      suppressClick = false;
      if (readSettings().ui.mode !== 'floating' || event.button !== 0) return;
      const rect = entry.getBoundingClientRect();
      drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moving: false };
      entry.setPointerCapture(event.pointerId);
    });
    entry.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointer) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moving && Math.hypot(dx, dy) < DRAG_START_DISTANCE) return;
      drag.moving = true;
      const availableX = Math.max(0, window.innerWidth - entry.offsetWidth);
      const availableY = Math.max(0, window.innerHeight - entry.offsetHeight);
      entry.style.left = `${Math.max(0, Math.min(availableX, drag.left + dx))}px`;
      entry.style.top = `${Math.max(0, Math.min(availableY, drag.top + dy))}px`;
    });
    function finish(event) {
      if (!drag || event.pointerId !== drag.pointer) return;
      const moving = drag.moving;
      suppressClick = moving;
      drag = null;
      if (!moving) return;
      const rect = entry.getBoundingClientRect();
      const availableX = Math.max(0, window.innerWidth - entry.offsetWidth);
      const availableY = Math.max(0, window.innerHeight - entry.offsetHeight);
      const settings = readSettings();
      saveSettings({ ...settings, ui: { ...settings.ui, position: { x: availableX ? rect.left / availableX : 0, y: availableY ? rect.top / availableY : 0 } } });
    }
    entry.addEventListener('pointerup', finish);
    entry.addEventListener('pointercancel', finish);
    entry.addEventListener('click', () => {
      if (suppressClick) { suppressClick = false; return; }
      view.open();
    });
  }

  function start(storage) {
    const view = createView();
    function report(error) { view.report(error); throw error; }
    try {
      if (!globalThis.Highlight || !globalThis.CSS?.highlights) throw new Error('此浏览器不支持原生关键词高亮，请更新电脑上的 Chrome 或 Edge。');
      let settings = validateSettings(storage.read(STORAGE_KEY, structuredClone(INITIAL_SETTINGS)));
      const highlighter = createHighlighter(createPainter());
      function save(next) {
        try {
          validateSettings(next);
          storage.write(STORAGE_KEY, next);
          settings = next;
          view.error.hidden = true;
          highlighter.update(settings.rules);
          positionEntry(view, settings.ui);
        } catch (error) { report(error); }
      }
      function renderRules() {
        view.ruleList.replaceChildren();
        view.empty.hidden = settings.rules.length > 0;
        for (const rule of settings.rules) {
          const rendered = createRuleCard(rule, patch => save({ ...settings, rules: settings.rules.map(item => item.id === rule.id ? { ...item, ...patch } : item) }), () => {
            save({ ...settings, rules: settings.rules.filter(item => item.id !== rule.id) });
            renderRules();
          });
          view.ruleList.append(rendered.card);
        }
      }
      view.add.addEventListener('click', () => {
        const rule = { id: crypto.randomUUID(), text: '', color: PALETTE[settings.rules.length % PALETTE.length], scopes: [...SCOPES], enabled: true };
        save({ ...settings, rules: [...settings.rules, rule] });
        renderRules();
        view.ruleList.lastElementChild.querySelector('.text').focus();
      });
      view.mode.addEventListener('change', () => save({ ...settings, ui: { ...settings.ui, mode: view.mode.value } }));
      attachDragging(view, () => settings, save);
      window.addEventListener('resize', () => positionEntry(view, settings.ui));
      storage.listen(STORAGE_KEY, (key, oldValue, next, remote) => {
        if (!remote) return;
        try {
          settings = validateSettings(next);
          renderRules();
          positionEntry(view, settings.ui);
          highlighter.update(settings.rules);
        } catch (error) { report(error); }
      });
      storage.menu('关键词高亮设置', view.open);
      renderRules();
      positionEntry(view, settings.ui);
      highlighter.update(settings.rules);
    } catch (error) { report(error); }
  }

  start({
    read: (key, initial) => GM_getValue(key, initial),
    write: (key, value) => GM_setValue(key, value),
    listen: (key, listener) => GM_addValueChangeListener(key, listener),
    menu: (label, callback) => GM_registerMenuCommand(label, callback),
  });
})();
