// ==UserScript==
// @name         Linux.do 荧光关键词高亮
// @namespace    linuxdo-keyword-highlighter
// @version      1.2.3
// @description  关键词分组、分区高亮、圆角荧光背景与阴影、短词覆盖长词、可拖动或贴边的设置入口。
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
  const PALETTE = [
    { label: '荧光青', color: '#18f0ff' },
    { label: '荧光黄', color: '#edff00' },
    { label: '荧光粉', color: '#ff5cc9' },
    { label: '荧光绿', color: '#83ff38' },
    { label: '荧光橙', color: '#ff913b' },
    { label: '荧光蓝', color: '#5c8dff' },
    { label: '荧光紫', color: '#bd73ff' },
    { label: '荧光红', color: '#ff5364' },
    { label: '荧光薄荷绿', color: '#32ffd2' },
    { label: '荧光金', color: '#ffd447' },
  ];
  const INITIAL_SETTINGS = {
    version: 2,
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
    if (!settings || settings.version !== 2) fail('version');
    if (!Array.isArray(settings.rules)) fail('rules');
    const ids = new Set();
    for (const [index, rule] of settings.rules.entries()) {
      if (!rule || typeof rule.id !== 'string' || !/^[a-z0-9-]+$/.test(rule.id) || ids.has(rule.id)) fail(`rules[${index}].id`);
      ids.add(rule.id);
      if (typeof rule.name !== 'string') fail(`rules[${index}].name`);
      if (!Array.isArray(rule.keywords) || rule.keywords.some(word => typeof word !== 'string')) fail(`rules[${index}].keywords`);
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

  function migrateSettings(settings) {
    if (settings?.version !== 1) return validateSettings(settings);
    if (!Array.isArray(settings.rules)) throw new TypeError('关键词高亮设置格式错误：rules');
    return validateSettings({
      ...settings,
      version: 2,
      rules: settings.rules.map(rule => ({
        id: rule?.id, name: '', keywords: [rule?.text],
        color: rule?.color, enabled: rule?.enabled, scopes: rule?.scopes,
      })),
    });
  }

  function compileRules(rules, scope) {
    return rules.flatMap((rule, order) => {
      if (!rule.enabled || !rule.scopes.includes(scope)) return [];
      return rule.keywords.flatMap((text, index) => {
        if (!text.length) return [];
        const literal = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return [{
          id: rule.id, key: `${rule.id}:${index}`, order,
          length: Array.from(text).length,
          // Lookahead includes overlapping occurrences without changing original text offsets.
          pattern: new RegExp(`(?=(${literal}))`, 'giu'),
        }];
      });
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
        const count = (active.get(event.rule.key)?.count || 0) + event.delta;
        if (count === 0) active.delete(event.rule.key);
        else active.set(event.rule.key, { rule: event.rule, count });
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

  const core = { validateSettings, migrateSettings, compileRules, findSegments, contrastText };
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
      if (node.matches(SKIP_SELECTOR) || node.tagName === 'BR' || (node !== root && node.matches(REGION_SELECTOR))) {
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

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  const ICONS = {
    marker: ['m15 4 5 5-9 9H6v-5z', 'm13 6 5 5', 'M4 21h16'],
    settings: ['M4 7h16', 'M4 17h16', 'M8 4v6', 'M16 14v6'],
    trash: ['M3 6h18', 'M9 6V3h6v3', 'm5 6 1 15h12l1-15', 'M10 10v7', 'M14 10v7'],
    close: ['m6 6 12 12', 'M18 6 6 18'],
    plus: ['M12 5v14', 'M5 12h14'],
  };

  function createIcon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.7');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }

  function iconButton(icon, label, className = 'icon-button') {
    const button = createElement('button', className);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(createIcon(icon));
    return button;
  }

  function createView() {
    const host = createElement('div');
    host.dataset.ldkhOwned = 'ui';
    host.id = 'ldkh-settings';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = createElement('style');
    style.textContent = `
      :host { color-scheme: light dark; font: 13px/1.5 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
      *, *::before, *::after { box-sizing: border-box; }
      [hidden] { display: none !important; }
      button, input, select, textarea { font: inherit; }
      button, select, input[type="checkbox"], input[type="color"] { cursor: pointer; }
      button { border: 1px solid light-dark(#d9dee7, #4b515c); border-radius: 7px; padding: 5px 9px; color: light-dark(#1f2933, #e7ecf3); background: light-dark(#fff, #282d36); }
      button:hover { background: light-dark(#f1f4f7, #353b46); }
      svg { display: block; width: 18px; height: 18px; flex: 0 0 auto; }
      .icon-button { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 5px; border-color: transparent; background: transparent; }
      .entry { position: fixed; z-index: 2147483647; display: grid; place-items: center; margin: 0; padding: 0; border: 1px solid #dde2ea; background: #fff; color: #4b5565; box-shadow: 0 2px 10px rgb(0 0 0 / 12%); user-select: none; touch-action: none; }
      .entry:hover { background: #f8fafc; color: #1f2937; box-shadow: 0 3px 12px rgb(0 0 0 / 18%); }
      .entry svg { width: 21px; height: 21px; }
      .entry[data-mode="left"], .entry[data-mode="right"] { top: 50%; transform: translateY(-50%); width: 34px; height: 42px; }
      .entry[data-mode="left"] { left: 0; right: auto; border-left: 0; border-radius: 0 11px 11px 0; }
      .entry[data-mode="right"] { right: 0; left: auto; border-right: 0; border-radius: 11px 0 0 11px; }
      .entry[data-mode="floating"] { width: 40px; height: 40px; border-radius: 12px; cursor: move; }
      dialog { width: min(540px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 0; border: 1px solid light-dark(#dce1e8, #404855); border-radius: 13px; background: light-dark(#fff, #1e232b); color: light-dark(#202936, #e6edf6); box-shadow: 0 16px 64px rgb(0 0 0 / 24%); }
      dialog::backdrop { background: rgb(0 0 0 / 28%); }
      .header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid light-dark(#e6eaf0, #353e4c); }
      .heading { font-size: 16px; font-weight: 600; margin: 0; }
      .hint { font-size: 12px; color: light-dark(#778394, #aebbd0); margin: 2px 0 0; }
      .content { padding: 13px 16px 15px; }
      .toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 11px; }
      .toolbar label { display: flex; align-items: center; gap: 7px; color: light-dark(#687587, #aebbd0); }
      select, input[type="text"], textarea { color: inherit; background: light-dark(#fff, #282f3a); border: 1px solid light-dark(#dce2eb, #4a5669); border-radius: 6px; padding: 5px 7px; }
      .add { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; background: light-dark(#f0f3f7, #303a48); font-weight: 500; }
      .add svg { width: 15px; height: 15px; }
      .rules { display: flex; flex-direction: column; gap: 5px; }
      .rule { display: flex; align-items: center; gap: 7px; padding: 6px 7px; border: 1px solid light-dark(#e4e8ef, #414b5b); border-radius: 8px; }
      .rule[data-paused="true"] { opacity: .65; }
      .group-toggle { display: grid; place-items: center; flex: 0 0 auto; padding: 3px; cursor: pointer; }
      .group-edit { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; text-align: left; border: 0; padding: 2px 3px; background: transparent; }
      .group-label { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .group-count { flex: 0 0 auto; font-size: 11px; color: light-dark(#7b8797, #aebbd0); }
      .color { flex: 0 0 auto; width: 25px; height: 25px; padding: 0; background: var(--swatch); border: 1px solid rgb(0 0 0 / 9%); border-radius: 6px; }
      .color:hover { background: var(--swatch); outline: 2px solid light-dark(#dce2eb, #566277); outline-offset: 2px; }
      .options { display: flex; align-items: center; gap: 4px; padding: 4px 6px; font-size: 11px; border: 0; color: light-dark(#687587, #b5c0d0); background: transparent; }
      .options svg { width: 15px; height: 15px; }
      .remove { color: light-dark(#8c96a4, #aebbd0); }
      .remove:hover { color: light-dark(#b42318, #ffb4ac); background: light-dark(#fff0ef, #462c2c); }
      .popover { inset: auto; margin: 0; padding: 12px; border: 1px solid light-dark(#dce2eb, #465263); border-radius: 10px; color: light-dark(#202936, #e6edf6); background: light-dark(#fff, #252c36); box-shadow: 0 8px 28px rgb(0 0 0 / 18%); max-height: calc(100dvh - 32px); overflow: auto; }
      .keyword-panel { width: min(370px, calc(100vw - 32px)); }
      .options-panel { width: 174px; }
      .color-panel { width: 236px; }
      .panel-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: -4px -4px 8px 0; }
      .panel-heading { font-weight: 600; margin: 0; }
      .panel-header .icon-button { width: 26px; height: 26px; }
      .palette { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 7px; padding: 3px 0 12px; }
      .swatch { display: grid; place-items: center; height: 31px; padding: 0; border: 1px solid rgb(0 0 0 / 10%); background: var(--swatch); font-size: 19px; font-weight: 600; }
      .swatch:hover { background: var(--swatch); outline: 1px solid light-dark(#9ca9bb, #b9c9e0); outline-offset: 2px; }
      .swatch[aria-pressed="true"] { outline: 2px solid light-dark(#46556b, #d9e2f0); outline-offset: 2px; }
      .custom-row { display: flex; align-items: center; gap: 8px; padding-top: 9px; border-top: 1px solid light-dark(#e6eaf0, #414b5b); }
      .custom-color { width: 29px; height: 27px; padding: 2px; border: 1px solid light-dark(#dce2eb, #566277); border-radius: 6px; background: transparent; }
      .color-value { margin-left: auto; font: 11px/1.5 Consolas, monospace; color: light-dark(#778394, #aebbd0); }
      .name { display: block; width: 100%; margin-bottom: 9px; }
      .keyword-list { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; margin-bottom: 9px; }
      .keyword-item { display: flex; align-items: center; gap: 2px; min-width: 0; }
      .text { width: 100%; min-width: 0; height: 31px; min-height: 31px; resize: vertical; white-space: pre; }
      .keyword-item .icon-button { width: 23px; height: 28px; padding: 4px; }
      .keyword-item svg { width: 13px; height: 13px; }
      .panel-hint { margin: 8px 0 0; font-size: 11px; color: light-dark(#7b8797, #aebbd0); }
      .rule-scopes { display: flex; flex-direction: column; gap: 9px; }
      .check { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
      input[type="checkbox"] { accent-color: light-dark(#35455f, #b9c9e0); margin: 0; width: 15px; height: 15px; }
      .empty { margin: 24px 0; text-align: center; color: light-dark(#66758a, #aebbd0); }
      .error { color: light-dark(#b42318, #ffb4ac); background: light-dark(#fff0ef, #462c2c); border-radius: 7px; padding: 10px 12px; margin-bottom: 14px; overflow-wrap: anywhere; }
      .footer { margin: 11px 0 0; color: light-dark(#778394, #aebbd0); font-size: 11px; }
    `;
    const entry = iconButton('marker', '打开关键词高亮设置', 'entry');
    const dialog = createElement('dialog');
    dialog.setAttribute('aria-label', '关键词高亮设置');
    const header = createElement('div', 'header');
    const heading = createElement('div');
    heading.append(createElement('h2', 'heading', '关键词高亮'), createElement('p', 'hint', '一组关键词，共用颜色和范围'));
    const close = iconButton('close', '关闭');
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
    const add = createElement('button', 'add', '添加分组');
    add.type = 'button';
    add.prepend(createIcon('plus'));
    toolbar.append(modeLabel, add);
    const ruleList = createElement('div', 'rules');
    const empty = createElement('p', 'empty', '还没有关键词，点击「添加分组」开始设置。');
    const footer = createElement('p', 'footer', '点组名编辑关键词，点范围调整设置。修改立即生效。');
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
    dialog.addEventListener('close', () => {
      for (const panel of shadow.querySelectorAll(':popover-open')) panel.hidePopover();
      entry.style.visibility = '';
    });
    return { host, shadow, entry, dialog, mode, add, ruleList, empty, error, open, report };
  }

  function createHighlighter() {
    const roots = new Map();
    const dirty = new Set();
    const sources = new WeakMap();
    let compiled = new Map();
    let colors = new Map();
    const css = createElement('style');
    css.dataset.ldkhOwned = 'highlight-styles';
    // One inline fragment paints its background, rounded corners and shadow together.
    // Scrolling and line wrapping are handled by layout, without a second geometry layer.
    css.textContent = `
      ldkh-text[data-ldkh-owned="text"] { display: contents; }
      ldkh-highlight[data-ldkh-rule] {
        display: inline; font: inherit; line-height: inherit; margin: 0; padding: 0; border: 0;
        color: var(--ldkh-text); background: var(--ldkh-color); border-radius: 3px;
        box-shadow: 0 1px 3px rgb(0 0 0 / 22%), 0 0 4px color-mix(in srgb, var(--ldkh-color) 30%, transparent);
        -webkit-box-decoration-break: clone; box-decoration-break: clone;
      }
    `;
    document.head.append(css);

    function restore(data) {
      for (const record of data.records) {
        sources.delete(record.source);
        if (record.host.contains(record.source)) {
          const text = record.replacement === null ? record.host.textContent : record.replacement;
          record.source.data = text;
          if (record.host.parentNode) record.host.replaceWith(record.source);
          else record.source.remove();
        } else {
          // If the site moves/replaces its bound Text, retire every fragment we made
          // and preserve the site's replacement nodes at their original position.
          const replacements = [];
          function visit(node) {
            if (!record.generated.has(node)) { replacements.push(node); return; }
            for (const child of node.childNodes) visit(child);
          }
          for (const child of record.host.childNodes) visit(child);
          record.source.data = record.replacement === null ? record.value : record.replacement;
          if (record.source.parentNode === record.firstParent) record.source.remove();
          record.host.replaceWith(...replacements);
        }
      }
      data.records.clear();
    }

    function wrapText(source, segments, data) {
      const text = source.data;
      const host = createElement('ldkh-text');
      host.dataset.ldkhOwned = 'text';
      const record = { source, host, value: text, generated: new Set(), firstParent: null, replacement: null };
      data.records.add(record);
      sources.set(source, record);
      source.replaceWith(host);
      let offset = 0;
      let first = true;
      function appendText(value, parent) {
        if (!value.length) return;
        const node = first ? source : document.createTextNode(value);
        node.data = value;
        record.generated.add(node);
        first = false;
        parent.append(node);
      }
      for (const segment of segments) {
        appendText(text.slice(offset, segment.start), host);
        // Discourse gives every native <mark> in .cooked its search highlight color.
        const mark = createElement('ldkh-highlight');
        record.generated.add(mark);
        mark.dataset.ldkhRule = segment.ruleId;
        const color = colors.get(segment.ruleId);
        mark.style.setProperty('--ldkh-color', color);
        mark.style.setProperty('--ldkh-text', contrastText(color));
        appendText(text.slice(segment.start, segment.end), mark);
        host.append(mark);
        offset = segment.end;
      }
      appendText(text.slice(offset), host);
      record.firstParent = source.parentNode;
    }

    function paint(root, data) {
      for (const run of collectRuns(root)) {
        const fragments = new Map();
        let firstNode = 0;
        for (const segment of findSegments(run.text, compiled.get(data.scope))) {
          while (run.nodes[firstNode].end <= segment.start) firstNode++;
          for (let index = firstNode; index < run.nodes.length && run.nodes[index].start < segment.end; index++) {
            const item = run.nodes[index];
            if (!fragments.has(item.node)) fragments.set(item.node, []);
            fragments.get(item.node).push({
              start: Math.max(segment.start, item.start) - item.start,
              end: Math.min(segment.end, item.end) - item.start,
              ruleId: segment.ruleId,
            });
          }
        }
        for (const [node, segments] of fragments) wrapText(node, segments, data);
      }
    }

    function discover() {
      for (const [root, data] of roots) {
        const region = REGIONS.find(item => root.matches(item.selector));
        if (!root.isConnected || !region) {
          restore(data);
          roots.delete(root);
        } else if (data.scope !== region.scope) {
          data.scope = region.scope;
          dirty.add(root);
        }
      }
      for (const region of REGIONS) {
        for (const root of document.querySelectorAll(region.selector)) {
          if (roots.has(root)) continue;
          roots.set(root, { scope: region.scope, records: new Set() });
          dirty.add(root);
        }
      }
    }

    function noteChanges(records) {
      let rescan = false;
      for (const record of records) {
        if (record.type === 'characterData') {
          const source = sources.get(record.target);
          // A bound Text assignment is a whole new value, not a new first fragment.
          if (source) source.replacement = record.target.data;
        }
        const target = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
        if (!target || target.closest('[data-ldkh-owned="ui"]')) continue;
        const root = target.closest(REGION_SELECTOR);
        if (root) dirty.add(root);
        if (record.type !== 'characterData') rescan = true;
      }
      return rescan;
    }

    const observe = () => mutations.observe(document.body, {
      childList: true, characterData: true, subtree: true,
      attributes: true, attributeFilter: ['class', 'contenteditable'],
    });
    function refresh(rescan) {
      const pendingRescan = noteChanges(mutations.takeRecords());
      mutations.disconnect();
      try {
        if (rescan || pendingRescan) discover();
        // Restore all affected regions first: a bound Text may have moved between them.
        for (const root of dirty) {
          const data = roots.get(root);
          if (data) restore(data);
        }
        for (const root of dirty) {
          const data = roots.get(root);
          if (data) paint(root, data);
        }
        dirty.clear();
      } finally {
        // Only external DOM writes should schedule work; our own wrapping is not observed.
        observe();
      }
    }
    const mutations = new MutationObserver(records => {
      const rescan = noteChanges(records);
      if (rescan || dirty.size) refresh(rescan);
    });
    observe();
    return {
      update(rules) {
        compiled = new Map(SCOPES.map(scope => [scope, compileRules(rules, scope)]));
        colors = new Map(rules.map(rule => [rule.id, rule.color]));
        for (const root of roots.keys()) dirty.add(root);
        refresh(true);
      },
    };
  }

  function createPopover(className, title) {
    const panel = createElement('div', `popover ${className}`);
    panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', title);
    const header = createElement('div', 'panel-header');
    const close = iconButton('close', `关闭${title}`);
    close.popoverTargetElement = panel;
    close.popoverTargetAction = 'hide';
    header.append(createElement('div', 'panel-heading', title), close);
    panel.append(header);
    return panel;
  }

  function attachPopover(button, panel) {
    // Native invoker association prevents light-dismiss followed by a manual reopen.
    button.popoverTargetElement = panel;
    button.popoverTargetAction = 'toggle';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', 'false');
    function position() {
      const anchor = button.getBoundingClientRect();
      const bounds = panel.getBoundingClientRect();
      const gutter = 16;
      panel.style.left = `${Math.max(gutter, Math.min(anchor.left, window.innerWidth - bounds.width - gutter))}px`;
      const below = anchor.bottom + 6;
      const top = below + bounds.height <= window.innerHeight - gutter ? below : anchor.top - bounds.height - 6;
      panel.style.top = `${Math.max(gutter, top)}px`;
    }
    panel.addEventListener('toggle', event => {
      button.setAttribute('aria-expanded', String(event.newState === 'open'));
      if (event.newState === 'open') position();
    });
    return () => {
      if (!panel.matches(':popover-open')) button.click();
      position();
    };
  }

  function createRuleCard(rule, onChange, onRemove) {
    let current = rule;
    const card = createElement('div', 'rule');
    card.dataset.ruleId = rule.id;
    const toggle = createElement('label', 'group-toggle');
    toggle.title = '勾选启用，取消勾选暂停';
    const enabled = createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = rule.enabled;
    enabled.setAttribute('aria-label', '启用关键词组');
    toggle.append(enabled);
    const edit = createElement('button', 'group-edit');
    edit.type = 'button';
    edit.setAttribute('aria-label', '编辑关键词分组');
    const label = createElement('span', 'group-label');
    const count = createElement('span', 'group-count');
    edit.append(label, count);
    const color = createElement('button', 'color');
    color.type = 'button';
    color.setAttribute('aria-label', '选择分组颜色');
    const remove = iconButton('trash', '删除分组', 'icon-button remove');
    const options = iconButton('settings', '分组设置', 'options');
    const summary = createElement('span');
    options.append(summary);
    const optionPanel = createPopover('options-panel', '分组设置');
    const scopes = createElement('div', 'rule-scopes');
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
    for (const region of REGIONS) checks.set(region.scope, check(region.label, rule.scopes.includes(region.scope)));
    optionPanel.append(scopes);
    attachPopover(options, optionPanel);

    const keywordPanel = createPopover('keyword-panel', '关键词分组');
    const name = createElement('input', 'name');
    name.type = 'text';
    name.value = rule.name;
    name.placeholder = '组名（可选），例如 Claude';
    name.setAttribute('aria-label', '分组名称');
    const words = createElement('div', 'keyword-list');
    const addWord = createElement('button', '', '添加关键词');
    addWord.type = 'button';
    keywordPanel.append(name, words, addWord,
      createElement('p', 'panel-hint', '组内关键词共用颜色、启用状态和生效区域。'));
    const showEditor = attachPopover(edit, keywordPanel);

    const colorPanel = createPopover('color-panel', '颜色选择');
    const palette = createElement('div', 'palette');
    const swatches = PALETTE.map(preset => {
      const swatch = createElement('button', 'swatch');
      swatch.type = 'button';
      swatch.setAttribute('aria-label', preset.label);
      swatch.title = `${preset.label} ${preset.color}`;
      swatch.style.setProperty('--swatch', preset.color);
      swatch.style.color = contrastText(preset.color);
      swatch.addEventListener('click', () => {
        change({ color: preset.color });
        colorPanel.hidePopover();
      });
      palette.append(swatch);
      return swatch;
    });
    const customRow = createElement('label', 'custom-row', '自定义');
    const customColor = createElement('input', 'custom-color');
    customColor.type = 'color';
    customColor.setAttribute('aria-label', '自定义颜色');
    const colorValue = createElement('span', 'color-value');
    customRow.append(customColor, colorValue);
    colorPanel.append(palette, customRow);
    attachPopover(color, colorPanel);

    function refreshSummary() {
      const filled = current.keywords.filter(word => word.length);
      label.textContent = current.name || filled[0] || '未填写关键词';
      count.textContent = `${filled.length} 个词`;
      edit.title = current.keywords.join('\n');
      const selected = REGIONS.filter(region => current.scopes.includes(region.scope));
      summary.textContent = !current.enabled ? '已暂停' : !selected.length ? '未选区域' : selected.length === REGIONS.length ? '全部区域' : `${selected.length} 个区域`;
      options.title = current.enabled ? selected.map(region => region.label).join('、') || '未选择区域' : '已暂停';
      card.dataset.paused = String(!current.enabled);
      color.style.setProperty('--swatch', current.color);
      color.title = `分组颜色 ${current.color}`;
      customColor.value = current.color;
      colorValue.textContent = current.color;
      swatches.forEach((swatch, index) => {
        const selected = PALETTE[index].color === current.color.toLowerCase();
        swatch.setAttribute('aria-pressed', String(selected));
        swatch.textContent = selected ? '✓' : '';
      });
    }
    function change(patch) {
      onChange(patch);
      current = { ...current, ...patch };
      refreshSummary();
    }
    function renderKeywords() {
      words.replaceChildren();
      current.keywords.forEach((word, index) => {
        const item = createElement('div', 'keyword-item');
        const text = createElement('textarea', 'text');
        text.rows = 1;
        text.wrap = 'off';
        text.value = word;
        text.placeholder = '关键词';
        text.setAttribute('aria-label', '关键词');
        const deleteWord = iconButton('close', '删除关键词');
        text.addEventListener('input', () => change({ keywords: current.keywords.map((value, at) => at === index ? text.value : value) }));
        deleteWord.addEventListener('click', () => {
          change({ keywords: current.keywords.filter((value, at) => at !== index) });
          renderKeywords();
        });
        item.append(text, deleteWord);
        words.append(item);
      });
    }
    addWord.addEventListener('click', () => {
      change({ keywords: [...current.keywords, ''] });
      renderKeywords();
      words.lastElementChild.querySelector('.text').focus();
    });
    name.addEventListener('input', () => change({ name: name.value }));
    customColor.addEventListener('input', () => change({ color: customColor.value }));
    function changeOptions() {
      change({ scopes: [...checks].filter(([, input]) => input.checked).map(([scope]) => scope) });
    }
    enabled.addEventListener('change', () => {
      try { change({ enabled: enabled.checked }); }
      finally {
        // Keep the checkbox aligned with saved state even when storage reports a failure.
        enabled.checked = current.enabled;
      }
    });
    for (const input of checks.values()) input.addEventListener('change', changeOptions);
    remove.addEventListener('click', onRemove);
    card.append(toggle, color, edit, options, remove, keywordPanel, optionPanel, colorPanel);
    refreshSummary();
    renderKeywords();
    return { card, openEditor() { showEditor(); words.querySelector('.text')?.focus(); } };
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
      const stored = storage.read(STORAGE_KEY, structuredClone(INITIAL_SETTINGS));
      let settings = migrateSettings(stored);
      if (settings !== stored) storage.write(STORAGE_KEY, settings);
      const highlighter = createHighlighter();
      function save(next) {
        try {
          validateSettings(next);
          const rulesChanged = next.rules !== settings.rules;
          storage.write(STORAGE_KEY, next);
          settings = next;
          view.error.hidden = true;
          if (rulesChanged) highlighter.update(settings.rules);
          positionEntry(view, settings.ui);
        } catch (error) { report(error); }
      }
      const renderedRules = new Map();
      function renderRules() {
        renderedRules.clear();
        view.ruleList.replaceChildren();
        view.empty.hidden = settings.rules.length > 0;
        for (const rule of settings.rules) {
          const rendered = createRuleCard(rule, patch => save({ ...settings, rules: settings.rules.map(item => item.id === rule.id ? { ...item, ...patch } : item) }), () => {
            save({ ...settings, rules: settings.rules.filter(item => item.id !== rule.id) });
            renderRules();
          });
          renderedRules.set(rule.id, rendered);
          view.ruleList.append(rendered.card);
        }
      }
      view.add.addEventListener('click', () => {
        const rule = { id: crypto.randomUUID(), name: '', keywords: [''], color: PALETTE[settings.rules.length % PALETTE.length].color, scopes: [...SCOPES], enabled: true };
        save({ ...settings, rules: [...settings.rules, rule] });
        renderRules();
        renderedRules.get(rule.id).openEditor();
      });
      view.mode.addEventListener('change', () => save({ ...settings, ui: { ...settings.ui, mode: view.mode.value } }));
      attachDragging(view, () => settings, save);
      window.addEventListener('resize', () => positionEntry(view, settings.ui));
      storage.listen(STORAGE_KEY, (key, oldValue, next, remote) => {
        if (!remote) return;
        try {
          settings = migrateSettings(next);
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
