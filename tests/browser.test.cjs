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
    const openEditor = async card => { await card.getByRole('button', { name: '编辑关键词分组', exact: true }).click(); return card.locator('.keyword-panel'); };
    const openOptions = async card => { await card.getByRole('button', { name: '分组设置', exact: true }).click(); return card.locator('.options-panel'); };
    const openColor = async card => { await card.getByRole('button', { name: '选择分组颜色', exact: true }).click(); return card.locator('.color-panel'); };
    const initialRanges = await snapshot(page);
    assert.ok(initialRanges.some(item => item.ruleId === 'openai' && item.text === 'Open' && item.root === 'list-title'));
    assert.ok(initialRanges.some(item => item.ruleId === 'phrase' && item.text === ' API' && item.root === 'list-title'));
    assert.ok(initialRanges.some(item => item.ruleId === 'ai' && item.root === 'topic-heading'));
    assert.ok(initialRanges.some(item => item.ruleId === 'ai' && item.block === 'code-block'));
    assert.ok(initialRanges.some(item => item.root === 'body-two'));
    assert.ok(initialRanges.every(item => item.connected));
    const postColors = { openai: 'rgb(24, 240, 255)', ai: 'rgb(237, 255, 0)', phrase: 'rgb(255, 92, 201)' };
    async function assertPostColors() {
      const actual = await page.locator('.cooked [data-ldkh-rule]').evaluateAll(elements => elements.map(element => ({ id: element.dataset.ldkhRule, background: getComputedStyle(element).backgroundColor })));
      assert.equal(new Set(actual.map(item => item.id)).size, 3);
      for (const item of actual) assert.equal(item.background, postColors[item.id], `${item.id} keeps its own color inside posts`);
    }
    await assertPostColors();
    // Exact native mark rule from Linux.do's Discourse stylesheet, loaded after our styles.
    await page.addStyleTag({ content: '.cooked mark,.d-editor-preview mark { text-decoration:none; background-color:var(--highlight); }' });
    await assertPostColors();
    assert.equal(await page.locator('#native-search-mark').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 77)');
    assert.equal(await page.locator('#body-link [data-ldkh-rule]').count(), 2);
    assert.ok(await page.locator('#quoted-reply [data-ldkh-rule]').count() > 0);
    checks.push('post, link, reply and quote colors stay independent of native Discourse search mark styles');
    assert.ok(!initialRanges.some(item => item.ruleId === 'openai' && ['paragraph-a', 'linebreak'].includes(item.block)));
    assert.ok(!initialRanges.some(item => item.root === 'editor' || item.root === 'navigation'));
    assert.equal(await page.evaluate(() => window.__testOriginalMarkup(document.getElementById('body-one')) === window.originalBody), true);
    assert.equal(await page.evaluate(() => window.originalTitleNode.isConnected), true);
    const marks = page.locator('[data-ldkh-rule]');
    assert.ok(await marks.count() > 0);
    assert.equal(await page.locator('#ldkh-shadows').count(), 0);
    const decoration = await marks.first().evaluate(element => {
      const style = getComputedStyle(element);
      return { radius: style.borderRadius, shadow: style.boxShadow, break: style.boxDecorationBreak, position: style.position };
    });
    assert.equal(decoration.radius, '3px');
    assert.notEqual(decoration.shadow, 'none');
    assert.equal(decoration.break, 'clone');
    assert.equal(decoration.position, 'static');
    assert.equal(await entry.textContent(), '');
    assert.equal(await entry.locator('svg').count(), 1);
    assert.equal(await entry.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
    checks.push('three scopes, inline overlaps, code, original text and elements, one rounded background/shadow fragment, white icon');

    const idleChanges = await page.evaluate(async () => {
      let changes = 0;
      const observer = new MutationObserver(records => { changes += records.length; });
      observer.observe(document.getElementById('body-one'), { childList: true, characterData: true, subtree: true });
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

    await entry.click();
    assert.equal(await dialog.isVisible(), true);
    assert.equal((await dialog.boundingBox()).width, 540);
    assert.ok((await cards.first().boundingBox()).height <= 44);
    assert.equal(await ui.getByRole('checkbox').count(), 0, 'settings stay collapsed until requested');
    const editButton = firstAI.getByRole('button', { name: '编辑关键词分组', exact: true });
    const optionButton = firstAI.getByRole('button', { name: '分组设置', exact: true });
    const editorPanel = await openEditor(firstAI);
    await editButton.click();
    assert.equal(await editorPanel.isVisible(), false, 'clicking the invoker must close instead of reopening');
    await openEditor(firstAI);
    await editorPanel.getByRole('button', { name: '关闭关键词分组', exact: true }).click();
    assert.equal(await editorPanel.isVisible(), false);
    const optionsPanel = await openOptions(firstAI);
    await optionButton.click();
    assert.equal(await optionsPanel.isVisible(), false);
    await openOptions(firstAI);
    await optionsPanel.getByRole('button', { name: '关闭分组设置', exact: true }).click();
    assert.equal(await optionsPanel.isVisible(), false);
    await openEditor(firstAI);
    await openOptions(firstAI);
    assert.equal(await editorPanel.isVisible(), false);
    assert.equal(await ui.locator(':popover-open').count(), 1);
    await openEditor(firstAI);
    assert.equal(await optionsPanel.isVisible(), false);
    assert.equal(await ui.locator(':popover-open').count(), 1);
    const mainBounds = await dialog.boundingBox();
    await page.mouse.click(mainBounds.x + 7, mainBounds.y + mainBounds.height / 2);
    assert.equal(await ui.locator(':popover-open').count(), 0, 'blank space inside the window closes a popup');
    assert.equal(await dialog.isVisible(), true);
    await editButton.focus();
    await editButton.press('Enter');
    assert.equal(await editorPanel.isVisible(), true);
    await editButton.press('Enter');
    assert.equal(await editorPanel.isVisible(), false);

    const presets = [
      ['荧光青', '#18f0ff', 'rgb(24, 240, 255)'],
      ['荧光粉', '#ff5cc9', 'rgb(255, 92, 201)'],
      ['荧光绿', '#83ff38', 'rgb(131, 255, 56)'],
      ['荧光橙', '#ff913b', 'rgb(255, 145, 59)'],
      ['荧光蓝', '#5c8dff', 'rgb(92, 141, 255)'],
      ['荧光紫', '#bd73ff', 'rgb(189, 115, 255)'],
      ['荧光红', '#ff5364', 'rgb(255, 83, 100)'],
      ['荧光薄荷绿', '#32ffd2', 'rgb(50, 255, 210)'],
      ['荧光金', '#ffd447', 'rgb(255, 212, 71)'],
      ['荧光黄', '#edff00', 'rgb(237, 255, 0)'],
    ];
    const colorPanel = await openColor(firstAI);
    assert.equal(await colorPanel.locator('.swatch').count(), 10);
    assert.equal(await colorPanel.getByRole('button', { name: '荧光黄', exact: true }).getAttribute('aria-pressed'), 'true');
    await colorPanel.screenshot({ path: path.join(output, `${channel}-color-picker.png`) });
    await colorPanel.getByRole('button', { name: '关闭颜色选择', exact: true }).click();
    assert.equal(await colorPanel.isVisible(), false);
    for (const [label, hex, rgb] of presets) {
      await openColor(firstAI);
      await colorPanel.getByRole('button', { name: label, exact: true }).click();
      assert.equal(await colorPanel.isVisible(), false);
      assert.equal((await storedSettings(page)).rules[1].color, hex);
      assert.ok((await page.locator('[data-ldkh-rule="ai"]').evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor))).every(color => color === rgb));
      assert.deepEqual((await storedSettings(page)).rules.filter(rule => rule.id !== 'ai').map(rule => rule.color), initial.rules.filter(rule => rule.id !== 'ai').map(rule => rule.color));
    }
    await openOptions(firstAI);
    await openColor(firstAI);
    assert.equal(await optionsPanel.isVisible(), false);
    await openEditor(firstAI);
    assert.equal(await colorPanel.isVisible(), false);
    await page.keyboard.press('Escape');
    checks.push('native invoker toggles, close buttons, popup switching, inside blank space and keyboard dismissal');
    checks.push('ten fluorescent presets save and repaint only their own group');
    await ui.getByRole('button', { name: '添加分组' }).click();
    assert.equal(await cards.count(), 4);
    const added = cards.last();
    await added.getByRole('textbox', { name: '关键词', exact: true }).fill('C++ [AI].*');
    const addedOptions = await openOptions(added);
    assert.equal(await ui.getByRole('checkbox').count(), 4);
    await addedOptions.getByRole('checkbox', { name: '列表标题', exact: true }).uncheck();
    await addedOptions.getByRole('checkbox', { name: '帖子页标题', exact: true }).uncheck();
    await settle(page);
    assert.ok((await snapshot(page)).some(item => item.block === 'literal' && item.text === 'C++ ['));
    const newRule = (await storedSettings(page)).rules[3];
    assert.deepEqual(newRule.keywords, ['C++ [AI].*']);
    assert.deepEqual(newRule.scopes, ['body']);
    await openEditor(added);
    await added.getByRole('textbox', { name: '关键词', exact: true }).focus();
    await added.getByRole('textbox', { name: '关键词', exact: true }).press('End');
    await added.getByRole('textbox', { name: '关键词', exact: true }).press('!');
    assert.equal(await added.getByRole('textbox', { name: '关键词', exact: true }).evaluate(element => element.getRootNode().activeElement === element), true);
    assert.equal((await storedSettings(page)).rules[3].keywords[0], 'C++ [AI].*!');
    await added.getByRole('textbox', { name: '关键词', exact: true }).fill('C++ [AI].*');
    const aiOptions = await openOptions(firstAI);
    await aiOptions.getByRole('checkbox', { name: '正文与回复', exact: true }).uncheck();
    await settle(page);
    assert.ok((await snapshot(page)).filter(item => item.ruleId === 'ai').every(item => ['list-title', 'topic-heading'].includes(item.root)));
    await aiOptions.getByRole('checkbox', { name: '正文与回复', exact: true }).check();
    await openColor(firstAI);
    await colorPanel.getByLabel('自定义颜色', { exact: true }).fill('#00ff66');
    await settle(page);
    assert.ok((await marks.filter({ hasText: 'AI' }).all()).length > 0);
    assert.ok((await page.locator('[data-ldkh-rule="ai"]').evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor))).every(color => color === 'rgb(0, 255, 102)'));
    assert.equal((await storedSettings(page)).rules[1].color, '#00ff66');
    assert.equal(await colorPanel.locator('.swatch[aria-pressed="true"]').count(), 0);
    assert.equal(await colorPanel.locator('.color-value').textContent(), '#00ff66');
    await colorPanel.getByRole('button', { name: '关闭颜色选择', exact: true }).click();
    await openColor(firstAI);
    assert.equal(await colorPanel.getByLabel('自定义颜色', { exact: true }).inputValue(), '#00ff66');
    await colorPanel.getByRole('button', { name: '荧光黄', exact: true }).click();
    await openOptions(firstAI);
    await aiOptions.getByRole('checkbox', { name: '启用', exact: true }).uncheck();
    await settle(page);
    assert.ok(!(await snapshot(page)).some(item => item.ruleId === 'ai'));
    await aiOptions.getByRole('checkbox', { name: '启用', exact: true }).check();
    await openEditor(firstAI);
    await firstAI.getByRole('textbox', { name: '关键词', exact: true }).fill('');
    await settle(page);
    assert.ok(!(await snapshot(page)).some(item => item.ruleId === 'ai'));
    assert.equal(await firstAI.locator('.group-label').textContent(), '未填写关键词');
    await firstAI.getByRole('textbox', { name: '关键词', exact: true }).fill('AI');
    await settle(page);
    await page.keyboard.press('Escape');

    await ui.getByRole('button', { name: '添加分组' }).click();
    const claude = cards.last();
    const claudeId = await claude.getAttribute('data-rule-id');
    const claudeEditor = claude.locator('.keyword-panel');
    await claudeEditor.getByRole('textbox', { name: '分组名称', exact: true }).fill('Claude');
    await claudeEditor.getByRole('textbox', { name: '关键词', exact: true }).fill('Claude Opus');
    await claudeEditor.getByRole('button', { name: '添加关键词', exact: true }).click();
    await claudeEditor.getByRole('textbox', { name: '关键词', exact: true }).last().fill('Anthropic');
    await claudeEditor.getByRole('button', { name: '添加关键词', exact: true }).click();
    await claudeEditor.getByRole('textbox', { name: '关键词', exact: true }).last().fill('Claude Sonnet');
    assert.deepEqual((await storedSettings(page)).rules[4].keywords, ['Claude Opus', 'Anthropic', 'Claude Sonnet']);
    assert.equal((await snapshot(page)).filter(item => item.ruleId === claudeId && item.block === 'group-example').length, 3);
    await claudeEditor.screenshot({ path: path.join(output, `${channel}-group-editor.png`) });
    const claudeOptions = await openOptions(claude);
    await claudeOptions.getByRole('checkbox', { name: '列表标题', exact: true }).uncheck();
    await claudeOptions.getByRole('checkbox', { name: '帖子页标题', exact: true }).uncheck();
    const claudeColor = await openColor(claude);
    await claudeColor.getByRole('button', { name: '荧光绿', exact: true }).click();
    assert.equal(await page.locator(`[data-ldkh-rule="${claudeId}"]`).count(), 3);
    assert.ok((await page.locator(`[data-ldkh-rule="${claudeId}"]`).evaluateAll(elements => elements.map(element => getComputedStyle(element).backgroundColor))).every(color => color === 'rgb(131, 255, 56)'));
    await openOptions(claude);
    await claudeOptions.getByRole('checkbox', { name: '启用', exact: true }).uncheck();
    assert.equal(await page.locator(`[data-ldkh-rule="${claudeId}"]`).count(), 0);
    assert.ok((await snapshot(page)).some(item => item.ruleId === 'ai'));
    await claudeOptions.getByRole('checkbox', { name: '启用', exact: true }).check();
    await page.keyboard.press('Escape');
    await dialog.screenshot({ path: path.join(output, `${channel}-settings.png`) });
    checks.push('compact rows, four collapsed options, grouped keywords share colors/scopes/pause, immediate save and focus');

    await ui.getByRole('button', { name: '关闭', exact: true }).click();
    await page.screenshot({ path: path.join(output, `${channel}-highlights-light.png`), fullPage: true });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(output, `${channel}-highlights-dark.png`), fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
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
    await page.evaluate(() => { window.originalDynamicNode.data = 'Claude Opus / Anthropic'; });
    await settle(page);
    assert.equal(await page.locator('#dynamic').textContent(), 'Claude Opus / Anthropic');
    assert.equal(await page.locator('#dynamic [data-ldkh-rule]').count(), 2);
    await page.evaluate(() => { window.originalDynamicNode.data = 'Fresh replacement'; });
    await settle(page);
    assert.equal(await page.locator('#dynamic').textContent(), 'Fresh replacement');
    assert.equal(await page.locator('#dynamic [data-ldkh-rule]').count(), 0);
    assert.equal(await page.evaluate(() => document.getElementById('dynamic').firstChild === window.originalDynamicNode), true);
    await page.evaluate(() => { window.originalDynamicNode.data = 'OpenAI API'; });
    await settle(page);
    checks.push('bound Text references survive repeated whole-value assignments, appended replies and SPA replacement');

    await page.evaluate(() => {
      const origin = document.createElement('p');
      origin.id = 'move-origin'; origin.textContent = 'OpenAI API';
      window.boundMoveNode = origin.firstChild;
      document.getElementById('body-one').append(origin);
      const target = document.createElement('p'); target.id = 'move-target';
      document.getElementById('body-two').append(target);
      const replacing = document.createElement('p');
      replacing.id = 'replace-origin'; replacing.textContent = 'OpenAI API';
      window.boundReplaceNode = replacing.firstChild;
      document.getElementById('body-one').append(replacing);
    });
    await settle(page);
    await page.evaluate(() => {
      document.getElementById('move-target').append(window.boundMoveNode);
      window.newBoundNode = document.createTextNode('Claude Sonnet');
      window.boundReplaceNode.replaceWith(window.newBoundNode);
    });
    await settle(page);
    assert.equal(await page.locator('#move-origin').textContent(), '');
    assert.equal(await page.locator('#move-target').textContent(), 'OpenAI API');
    assert.equal(await page.locator('#replace-origin').textContent(), 'Claude Sonnet');
    assert.equal(await page.evaluate(() => window.boundMoveNode.isConnected && window.newBoundNode.isConnected), true);
    assert.equal(await page.evaluate(() => window.boundReplaceNode.isConnected), false);
    await page.evaluate(() => { window.boundMoveNode.data = 'Anthropic'; window.newBoundNode.data = 'OpenAI API'; });
    await settle(page);
    assert.equal(await page.locator('#move-target').textContent(), 'Anthropic');
    assert.equal(await page.locator('#replace-origin').textContent(), 'OpenAI API');
    checks.push('moving and replacing bound Text nodes preserve complete values, new bindings and placement');

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

    await page.locator('#code-scroll').scrollIntoViewIfNeeded();
    const scrollSamples = await page.evaluate(async () => {
      const code = document.getElementById('code-scroll');
      const mark = code.querySelector('[data-ldkh-rule]');
      const range = document.createRange();
      range.selectNodeContents(mark);
      const samples = [];
      let changes = 0;
      const observer = new MutationObserver(records => { changes += records.length; });
      observer.observe(code, { childList: true, characterData: true, subtree: true });
      for (const x of [0, (code.scrollWidth - code.clientWidth) / 2, code.scrollWidth]) {
        code.scrollLeft = x;
        const box = mark.getBoundingClientRect();
        const text = range.getBoundingClientRect();
        samples.push({ delta: Math.abs(box.left - text.left) + Math.abs(box.right - text.right), shadow: getComputedStyle(mark).boxShadow });
        await new Promise(requestAnimationFrame);
      }
      for (const y of [window.scrollY + 100, 0, 240]) {
        window.scrollTo(0, y);
        const box = mark.getBoundingClientRect();
        const text = range.getBoundingClientRect();
        samples.push({ delta: Math.abs(box.left - text.left) + Math.abs(box.right - text.right), shadow: getComputedStyle(mark).boxShadow });
        await new Promise(requestAnimationFrame);
      }
      observer.disconnect();
      return { samples, changes };
    });
    assert.ok(scrollSamples.samples.every(sample => sample.delta < 0.1 && sample.shadow !== 'none'));
    assert.equal(scrollSamples.changes, 0, 'scrolling must not repaint an independent shadow layer or rewrite text');
    checks.push('horizontal and vertical scroll samples retain a single native fragment without DOM churn');

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
    const markBeforeDrag = await marks.first().boundingBox();
    for (let step = 1; step <= 6; step++) {
      await page.mouse.move(beforeDrag.x - 220 * step / 6, beforeDrag.y - 120 * step / 6);
      assert.deepEqual(await marks.first().boundingBox(), markBeforeDrag);
    }
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
    assert.equal(await cards.count(), 5);
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
    const oldText = (await storedSettings(page)).rules[0].keywords[0];
    await openEditor(cards.first());
    await page.evaluate(() => { window.__testFailWrites = true; });
    await cards.first().getByRole('textbox', { name: '关键词', exact: true }).fill('unsaved');
    assert.match(await ui.getByRole('alert').textContent(), /GM storage denied/);
    assert.equal((await storedSettings(page)).rules[0].keywords[0], oldText);
    await page.evaluate(() => { window.__testFailWrites = false; });
    await cards.first().getByRole('textbox', { name: '关键词', exact: true }).fill(oldText);
    assert.equal(await ui.getByRole('alert').isVisible(), false);
    assert.ok(errors.length > 0);
    assert.ok(errors.every(message => message === 'Test: GM storage denied'));
    checks.push('failed persistence is visible and leaves saved settings unchanged');

    const migrated = await context.newPage();
    const oldSeed = { ...structuredClone(initial), version: 1, rules: initial.rules.map(({ name, keywords, ...rule }) => ({ ...rule, text: keywords[0] })) };
    await loadFixture(migrated, oldSeed);
    assert.deepEqual(await storedSettings(migrated), initial);
    assert.equal(await migrated.evaluate(() => window.__testWrites), 1);
    assert.deepEqual(await snapshot(migrated), initialRanges);
    await migrated.reload();
    await migrated.addScriptTag({ path: scriptPath });
    await settle(migrated);
    assert.equal(await migrated.evaluate(() => window.__testWrites), 0);
    await migrated.close();
    checks.push('legacy v1 settings migrate once and preserve every existing rule');

    const bad = await context.newPage();
    const badErrors = [];
    bad.on('pageerror', error => badErrors.push(error.message));
    await loadFixture(bad, { ...structuredClone(initial), version: 99 });
    assert.match(await bad.locator('#ldkh-settings').getByRole('alert').textContent(), /设置格式错误：version/);
    assert.equal((await snapshot(bad)).length, 0);
    assert.ok(badErrors.some(message => message.includes('设置格式错误')));
    await bad.close();
    checks.push('corrupt storage fails visibly');

    return { browser: channel, result: 'passed', checks, initialFragments: initialRanges.length, scrollSamples: scrollSamples.samples.length, unexpectedErrors: [] };
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
