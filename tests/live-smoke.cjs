const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { scriptPath, initial, installAdapter, settle } = require('./harness.cjs');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const scriptErrors = [];
  const networkFailures = [];
  let stage = 'load public list';
  let responseStatus;
  page.on('pageerror', error => {
    if (error.stack?.includes('linuxdo-keyword-highlighter') || error.message.includes('关键词高亮')) scriptErrors.push(error.message);
  });
  page.on('requestfailed', request => networkFailures.push({ url: request.url(), error: request.failure().errorText }));
  page.on('response', response => {
    if (response.status() >= 400) networkFailures.push({ url: response.url(), status: response.status() });
  });
  const output = path.resolve(__dirname, '..', 'test-results');
  fs.mkdirSync(output, { recursive: true });
  try {
    await installAdapter(page, null);
    responseStatus = (await page.goto('https://linux.do/', { waitUntil: 'domcontentloaded' })).status();
    const firstTitle = page.locator('.topic-list .topic-list-item a.title').first();
    await firstTitle.waitFor();
    const titleText = (await firstTitle.textContent()).trim();
    stage = 'highlight real list';
    assert.ok(titleText.length > 1);
    const actualState = structuredClone(initial);
    actualState.rules = [
      { id: 'live-long', text: titleText, color: '#18f0ff', enabled: true, scopes: ['list', 'topic'] },
      { id: 'live-short', text: Array.from(titleText)[0], color: '#edff00', enabled: true, scopes: ['list', 'topic'] },
    ];
    await page.evaluate(next => window.GM_setValue('linuxdo-keyword-highlighter-v1', next), actualState);
    await page.addScriptTag({ path: scriptPath });
    await page.waitForFunction(() => CSS.highlights.has('ldkh-live-short') && CSS.highlights.has('ldkh-live-long'));
    const listEvidence = await page.evaluate(() => ({
      titles: document.querySelectorAll('.topic-list .topic-list-item a.title').length,
      matchedRanges: [...CSS.highlights].filter(([name]) => name.startsWith('ldkh-')).reduce((sum, [, value]) => sum + value.size, 0),
      shadows: document.getElementById('ldkh-shadows').shadowRoot.querySelectorAll('.shadow').length,
    }));
    assert.ok(listEvidence.matchedRanges > 1 && listEvidence.shadows > 0);
    await page.screenshot({ path: path.join(output, 'linuxdo-list-live.png') });

    stage = 'navigate to real topic';
    await firstTitle.click();
    await page.locator('h1 a.fancy-title').first().waitFor();
    const firstBody = page.locator('.topic-body .cooked').first();
    await firstBody.waitFor();
    assert.equal(await page.locator('#ldkh-settings').count(), 1);
    const bodyOriginal = await firstBody.innerHTML();
    stage = 'highlight real topic';
    const bodyText = (await firstBody.innerText()).trim();
    const bodyWord = Array.from(bodyText.split(/\s+/)[0]).slice(0, 4).join('');
    assert.ok(bodyWord.length > 0);
    actualState.rules.push({ id: 'live-body', text: bodyWord, color: '#ff5cc9', enabled: true, scopes: ['body'] });
    await page.evaluate(next => window.__testRemoteUpdate(next), actualState);
    await page.waitForFunction(() => CSS.highlights.has('ldkh-live-body'));
    await settle(page);
    const topicEvidence = await page.evaluate(() => ({
      headingTitles: document.querySelectorAll('h1 a.fancy-title').length,
      cookedPosts: document.querySelectorAll('.topic-body .cooked').length,
      bodyRanges: CSS.highlights.get('ldkh-live-body').size,
      titleRanges: [...CSS.highlights.get('ldkh-live-long') || []].filter(range => range.startContainer.parentElement.closest('h1 a.fancy-title')).length,
      shadows: document.getElementById('ldkh-shadows').shadowRoot.querySelectorAll('.shadow').length,
      allRangesConnected: [...CSS.highlights].filter(([name]) => name.startsWith('ldkh-')).every(([, value]) => [...value].every(range => range.startContainer.isConnected && range.endContainer.isConnected)),
    }));
    assert.ok(topicEvidence.bodyRanges > 0 && topicEvidence.titleRanges > 0 && topicEvidence.allRangesConnected);
    assert.equal(await firstBody.innerHTML(), bodyOriginal);
    assert.deepEqual(scriptErrors, []);
    await page.screenshot({ path: path.join(output, 'linuxdo-topic-live.png') });
    await page.locator('#ldkh-settings').getByRole('button', { name: '打开关键词高亮设置' }).click();
    assert.equal(await page.locator('#ldkh-settings').getByRole('dialog').isVisible(), true);
    await page.locator('#ldkh-settings').getByRole('dialog').screenshot({ path: path.join(output, 'linuxdo-settings-live.png') });
    const result = { result: 'passed', browser: 'chrome', site: 'https://linux.do/', topicUrl: page.url(), checks: ['real list DOM', 'real SPA navigation', 'real topic title', 'real cooked post', 'unchanged post markup', 'settings dialog'], listEvidence, topicEvidence, scriptErrors };
    fs.writeFileSync(path.join(output, 'live-results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const evidence = {
      result: 'failed', stage, url: page.url(), responseStatus,
      title: await page.title(), error: error.message, networkFailures, scriptErrors,
      body: await page.locator('body').innerText(),
    };
    fs.writeFileSync(path.join(output, 'live-results.json'), JSON.stringify(evidence, null, 2));
    await page.screenshot({ path: path.join(output, 'linuxdo-live-failure.png') });
    throw error;
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
