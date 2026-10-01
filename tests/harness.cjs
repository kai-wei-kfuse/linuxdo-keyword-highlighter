const fs = require('node:fs');
const path = require('node:path');

const scriptPath = path.resolve(__dirname, '..', 'linuxdo-keyword-highlighter.user.js');
const fixture = fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8');
const storageKey = 'linuxdo-keyword-highlighter-v1';
const initial = {
  version: 2,
  rules: [
    { id: 'openai', name: '', keywords: ['OpenAI'], color: '#18f0ff', enabled: true, scopes: ['list', 'topic', 'body'] },
    { id: 'ai', name: '', keywords: ['AI'], color: '#edff00', enabled: true, scopes: ['list', 'topic', 'body'] },
    { id: 'phrase', name: '', keywords: ['OpenAI API'], color: '#ff5cc9', enabled: true, scopes: ['list', 'topic', 'body'] },
  ],
  ui: { mode: 'right', position: { x: 0.94, y: 0.72 } },
};

async function installAdapter(page, seed) {
  // This adapter is confined to tests; production only calls real Tampermonkey APIs.
  await page.addInitScript(({ seedValue, key }) => {
    if (seedValue !== null && sessionStorage.getItem(key) === null) sessionStorage.setItem(key, JSON.stringify(seedValue));
    window.__testWrites = 0;
    window.__testListeners = [];
    window.GM_getValue = (name, fallback) => {
      const stored = sessionStorage.getItem(name);
      return stored === null ? structuredClone(fallback) : JSON.parse(stored);
    };
    window.GM_setValue = (name, value) => {
      if (window.__testFailWrites) throw new Error('Test: GM storage denied');
      sessionStorage.setItem(name, JSON.stringify(value));
      window.__testWrites++;
    };
    window.GM_addValueChangeListener = (name, callback) => { window.__testListeners.push({ name, callback }); return window.__testListeners.length; };
    window.GM_registerMenuCommand = (name, callback) => { window.__testMenu = callback; return 1; };
    window.__testRemoteUpdate = next => {
      const previous = window.GM_getValue(key);
      sessionStorage.setItem(key, JSON.stringify(next));
      for (const item of window.__testListeners) item.callback(key, previous, next, true);
    };
    window.__testSnapshot = () => [...document.querySelectorAll('mark[data-ldkh-rule]')].map(mark => ({
      ruleId: mark.dataset.ldkhRule, text: mark.textContent, connected: mark.isConnected,
      root: mark.closest('a.title,a.fancy-title,.cooked')?.id,
      block: mark.closest('p,pre')?.id,
    }));
    window.__testOriginalMarkup = element => {
      const clone = element.cloneNode(true);
      for (const owned of clone.querySelectorAll('ldkh-text[data-ldkh-owned="text"],mark[data-ldkh-rule]')) owned.replaceWith(...owned.childNodes);
      return clone.innerHTML;
    };
  }, { seedValue: seed, key: storageKey });
}

async function loadFixture(page, seed = initial) {
  await installAdapter(page, seed);
  await page.route('https://linux.do/__ldkh_fixture__', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixture }));
  await page.goto('https://linux.do/__ldkh_fixture__');
  await page.addScriptTag({ path: scriptPath });
  await settle(page);
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const snapshot = page => page.evaluate(() => window.__testSnapshot());
const storedSettings = page => page.evaluate(key => window.GM_getValue(key), storageKey);

module.exports = { scriptPath, storageKey, initial, installAdapter, loadFixture, settle, snapshot, storedSettings };
