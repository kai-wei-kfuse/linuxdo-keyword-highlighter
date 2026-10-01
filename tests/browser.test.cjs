const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { scriptPath, initial, loadFixture, settle, snapshot, storedSettings } = require('./harness.cjs');

const output = path.resolve(__dirname, '..', 'test-results');
fs.mkdirSync(output, { recursive: true });

async function run(channel) {
  const browser = await chromium.launch({ channel, headless: true });
  const context = await browser.newContext({ viewport: { width: 1120, height: 880 }, colorScheme: 'light' });
  const page = await context.newPage();
  const errors = [];
  const checks = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await loadFixture(page);
    const ui = page.locator('#ldkh-settings');
    const entry = ui.getByRole('button', { name: '打开关键词高亮设置' });
    const dialog = ui.getByRole('dialog', { name: '关键词高亮设置' });
    const cards = ui.locator('.rule');
    const firstAI = ui.locator('[data-rule-id="ai"]');
    const initialRanges = await snapshot(page);
    assert.ok(initialRanges.some(item => item.ruleId === 'openai' && item.text === 'Open' && item.root === 'list-title'));
    assert.ok(initialRanges.some(item => item.ruleId === 'phrase' && item.text === ' API' && item.root === 'list-title'));
    assert.ok(initialRanges.some(item => item.ruleId === 'ai' && item.root === 'topic-heading'));
    assert.ok(initialRanges.some(item => item.ruleId === 'ai' && item.block === 'code-block'));
    assert.ok(initialRanges.some(item => item.root === 'body-two'));
    assert.ok(initialRanges.every(item => item.connected));
    assert.ok(!initialRanges.some(item => item.ruleId === 'openai' && ['paragraph-a', 'linebreak'].includes(item.block)));
    assert.ok(!initialRanges.some(item => item.root === 'editor' || item.root === 'navigation'));
    assert.equal(await page.evaluate(() => document.getElementById('body-one').innerHTML === window.originalBody), true);
    assert.equal(await page.evaluate(() => window.originalTitleNode.isConnected), true);
    const shadowCount = await page.locator('#ldkh-shadows .shadow').count();
    assert.ok(shadowCount > 0);
    assert.notEqual(await page.locator('#ldkh-shadows .shadow').first().evaluate(element => getComputedStyle(element).boxShadow), 'none');
    checks.push('three scopes, overlaps across inline tags, code, DOM preservation, shadows');

    const idleChanges = await page.evaluate(async () => {
      const layer = document.getElementById('ldkh-shadows').shadowRoot.querySelector('div');
      let changes = 0;
      const observer = new MutationObserver(records => { changes += records.length; });
      observer.observe(layer, { childList: true });
      for (let index = 0; index < 8; index++) await new Promise(requestAnimationFrame);
      observer.disconnect();
      return changes;
    });
    assert.equal(idleChanges, 0, 'idle highlighter must not trigger a mutation/animation loop');
    await page.locator('#body-link').click();
    assert.equal(await page.evaluate(() => window.fixtureClicks), 1);
    assert.equal(await page.evaluate(() => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('code-block'));
      selection.removeAllRanges(); selection.addRange(range);
      const selected = selection.toString(); selection.removeAllRanges();
      return selected === document.getElementById('code-block').textContent;
    }), true);
    checks.push('no idle loop, original link handler, unchanged code selection');

    await page.screenshot({ path: path.join(output, `${channel}-highlights-light.png`), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(output, `${channel}-highlights-dark.png`), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
    await entry.click();
    assert.equal(await dialog.isVisible(), true);
    await ui.getByRole('button', { name: '添加关键词' }).click();
    assert.equal(await cards.count(), 4);
    const added = cards.last();
    await added.getByRole('textbox', { name: '关键词', exact: true }).fill('C++ [AI].*');
    await added.getByRole('checkbox', { name: '列表标题', exact: true }).uncheck();
    await added.getByRole('checkbox', { name: '帖子页标题', exact: true }).uncheck();
    await settle(page);
    assert.ok((await snapshot(page)).some(item => item.block === 'literal' && item.text === 'C++ ['));
    const newRule = (await storedSettings(page)).rules[3];
    assert.equal(newRule.text, 'C++ [AI].*');
    assert.deepEqual(newRule.scopes, ['body']);
    assert.equal(await added.getByRole('textbox', { name: '关键词', exact: true }).evaluate(element => element.getRootNode().activeElement === element), false);
    await added.getByRole('textbox', { name: '关键词', exact: true }).focus();
    await added.getByRole('textbox', { name: '关键词', exact: true }).press('End');
    await added.getByRole('textbox', { name: '关键词', exact: true }).press('!');
    assert.equal(await added.getByRole('textbox', { name: '关键词', exact: true }).evaluate(element => element.getRootNode().activeElement === element), true);
    assert.equal((await storedSettings(page)).rules[3].text, 'C++ [AI].*!');
    await added.getByRole('textbox', { name: '关键词', exact: true }).fill('C++ [AI].*');
    await firstAI.getByRole('checkbox', { name: '正文与回复', exact: true }).uncheck();
    await settle(page);
    assert.ok((await snapshot(page)).filter(item => item.ruleId === 'ai').every(item => ['list-title', 'topic-heading'].includes(item.root)));
    await firstAI.getByRole('checkbox', { name: '正文与回复', exact: true }).check();
    await firstAI.getByLabel('关键词背景色', { exact: true }).fill('#00ff66');
    await settle(page);
    assert.ok(await page.locator('style[data-ldkh-owned="highlight-styles"]').evaluate(element => element.textContent.includes('background-color: #00ff66')));
    assert.equal((await storedSettings(page)).rules[1].color, '#00ff66');
    await firstAI.getByLabel('关键词背景色', { exact: true }).fill('#edff00');
    await firstAI.getByRole('checkbox', { name: '启用', exact: true }).uncheck();
    await settle(page);
    assert.ok(!(await snapshot(page)).some(item => item.ruleId === 'ai'));
    await firstAI.getByRole('checkbox', { name: '启用', exact: true }).check();
    await firstAI.getByRole('textbox', { name: '关键词', exact: true }).fill('');
    await settle(page);
    assert.ok(!(await snapshot(page)).some(item => item.ruleId === 'ai'));
    assert.equal(await firstAI.locator('.rule-status').textContent(), '未填写关键词');
    await firstAI.getByRole('textbox', { name: '关键词', exact: true }).fill('AI');
    await settle(page);
    await dialog.screenshot({ path: path.join(output, `${channel}-settings.png`) });
    checks.push('immediate save, independent regions and color, literal input, typing focus, pause, empty draft');

    await ui.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => {
      window.originalDynamicNode.data = 'OpenAI API';
      document.getElementById('posts').insertAdjacentHTML('beforeend', '<article><div class="topic-body"><div class="cooked" id="new-reply">新回复 AI</div></div></article>');
      document.getElementById('list-container').innerHTML = '<table class="topic-list"><tbody><tr class="topic-list-item"><td><a class="title" id="new-list-title">新列表 OpenAI API</a></td></tr></tbody></table>';
      history.pushState({}, '', '/latest');
    });
    await settle(page);
    const dynamicRanges = await snapshot(page);
    assert.ok(dynamicRanges.some(item => item.block === 'dynamic' && item.ruleId === 'phrase'));
    assert.ok(dynamicRanges.some(item => item.root === 'new-reply'));
    assert.ok(dynamicRanges.some(item => item.root === 'new-list-title'));
    assert.ok(!dynamicRanges.some(item => item.root === 'list-title'));
    assert.ok(dynamicRanges.every(item => item.connected));
    assert.equal(await page.evaluate(() => window.originalDynamicNode.isConnected), true);
    checks.push('live bound text changes, appended replies, SPA replacement, stale ranges removed');

    const writesBeforeRemote = await page.evaluate(() => window.__testWrites);
    const listOnly = await storedSettings(page);
    listOnly.rules[1].scopes = ['list'];
    await page.evaluate(next => window.__testRemoteUpdate(next), listOnly);
    await settle(page);
    assert.ok((await snapshot(page)).some(item => item.root === 'new-list-title' && item.ruleId === 'ai'));
    await page.evaluate(() => {
      const title = document.getElementById('new-list-title');
      title.className = 'fancy-title';
      document.querySelector('#topic-title h1').append(title);
    });
    await settle(page);
    assert.ok(!(await snapshot(page)).some(item => item.root === 'new-list-title' && item.ruleId === 'ai'));
    listOnly.rules[1].scopes = ['list', 'topic', 'body'];
    await page.evaluate(next => window.__testRemoteUpdate(next), listOnly);
    await settle(page);
    assert.equal(await page.evaluate(() => window.__testWrites), writesBeforeRemote);
    checks.push('region changes and cross-tab changes use current scope without write loops');

    await page.locator('#code-scroll').evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await settle(page);
    const codeClip = await page.evaluate(() => {
      const code = document.getElementById('code-scroll');
      const bounds = code.getBoundingClientRect();
      const boxes = [...document.getElementById('ldkh-shadows').shadowRoot.querySelectorAll('.shadow')]
        .map(element => element.getBoundingClientRect())
        .filter(rect => rect.top >= bounds.top && rect.bottom <= bounds.bottom);
      return { count: boxes.length, clipped: boxes.every(rect => rect.left >= bounds.left && rect.right <= bounds.right) };
    });
    assert.ok(codeClip.count > 0);
    assert.equal(codeClip.clipped, true);
    checks.push('horizontal code scrolling clips shadow boxes');

    await entry.click();
    await ui.getByRole('combobox', { name: '设置入口位置' }).selectOption('left');
    await ui.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal((await entry.boundingBox()).x, 0);
    await entry.click();
    await ui.getByRole('combobox', { name: '设置入口位置' }).selectOption('right');
    await ui.getByRole('button', { name: '关闭', exact: true }).click();
    const right = await entry.boundingBox();
    assert.equal(right.x + right.width, 1120);
    await entry.click();
    await ui.getByRole('combobox', { name: '设置入口位置' }).selectOption('floating');
    await ui.getByRole('button', { name: '关闭', exact: true }).click();
    const beforeDrag = await entry.boundingBox();
    await page.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + beforeDrag.height / 2);
    await page.mouse.down();
    await page.mouse.move(beforeDrag.x - 220, beforeDrag.y - 120, { steps: 6 });
    await page.mouse.up();
    await settle(page);
    const afterDrag = await entry.boundingBox();
    assert.ok(afterDrag.x < beforeDrag.x - 100);
    assert.ok(afterDrag.y < beforeDrag.y - 50);
    assert.equal(await dialog.isVisible(), false);
    const savedPosition = (await storedSettings(page)).ui.position;
    await page.reload();
    await page.addScriptTag({ path: scriptPath });
    await settle(page);
    assert.deepEqual((await storedSettings(page)).ui.position, savedPosition);
    const afterReload = await entry.boundingBox();
    assert.ok(Math.abs(afterReload.x - afterDrag.x) < 1);
    assert.ok(Math.abs(afterReload.y - afterDrag.y) < 1);
    assert.equal(await cards.count(), 4);
    await page.setViewportSize({ width: 800, height: 600 });
    await settle(page);
    const resized = await entry.boundingBox();
    assert.ok(resized.x >= 0 && resized.y >= 0 && resized.x + resized.width <= 800 && resized.y + resized.height <= 600);
    await page.evaluate(() => window.__testMenu());
    assert.equal(await dialog.isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), false);
    await entry.waitFor({ state: 'visible' });
    assert.equal(await entry.isVisible(), true);
    checks.push('left/right tabs, dragging without opening, reload persistence, viewport resize, menu and Escape');

    assert.deepEqual(errors, []);
    await entry.click();
    const oldText = (await storedSettings(page)).rules[0].text;
    await page.evaluate(() => { window.__testFailWrites = true; });
    await cards.first().getByRole('textbox', { name: '关键词', exact: true }).fill('unsaved');
    assert.match(await ui.getByRole('alert').textContent(), /GM storage denied/);
    assert.equal((await storedSettings(page)).rules[0].text, oldText);
    await page.evaluate(() => { window.__testFailWrites = false; });
    await cards.first().getByRole('textbox', { name: '关键词', exact: true }).fill(oldText);
    assert.equal(await ui.getByRole('alert').isVisible(), false);
    assert.ok(errors.length > 0);
    assert.ok(errors.every(message => message === 'Test: GM storage denied'));
    checks.push('failed persistence is visible and leaves saved settings unchanged');

    const bad = await context.newPage();
    const badErrors = [];
    bad.on('pageerror', error => badErrors.push(error.message));
    await loadFixture(bad, { ...structuredClone(initial), version: 99 });
    assert.match(await bad.locator('#ldkh-settings').getByRole('alert').textContent(), /设置格式错误：version/);
    assert.equal((await snapshot(bad)).length, 0);
    assert.ok(badErrors.some(message => message.includes('设置格式错误')));
    await bad.close();
    checks.push('corrupt storage fails visibly');

    return { browser: channel, result: 'passed', checks, initialRanges: initialRanges.length, visibleShadows: shadowCount, unexpectedErrors: [] };
  } finally {
    await context.close();
    await browser.close();
  }
}

(async () => {
  const results = [];
  for (const channel of ['chrome', 'msedge']) {
    console.log(`Checking ${channel}`);
    results.push(await run(channel));
  }
  fs.writeFileSync(path.join(output, 'browser-results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
