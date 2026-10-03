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
      { id: 'live-long', name: '', keywords: [titleText], color: '#18f0ff', enabled: true, scopes: ['list', 'topic'] },
      { id: 'live-short', name: '', keywords: [Array.from(titleText)[0]], color: '#edff00', enabled: true, scopes: ['list', 'topic'] },
    ];
    await page.evaluate(next => window.GM_setValue('linuxdo-keyword-highlighter-v1', next), actualState);
    await page.addScriptTag({ path: scriptPath });
    await page.waitForFunction(() => document.querySelector('[data-ldkh-rule="live-short"]') && document.querySelector('[data-ldkh-rule="live-long"]'));
    const listEvidence = await page.evaluate(() => ({
      titles: document.querySelectorAll('.topic-list .topic-list-item a.title').length,
      matchedFragments: document.querySelectorAll('[data-ldkh-rule]').length,
      roundedShadows: [...document.querySelectorAll('[data-ldkh-rule]')].every(mark => getComputedStyle(mark).borderRadius === '3px' && getComputedStyle(mark).boxShadow !== 'none'),
    }));
    assert.ok(listEvidence.matchedFragments > 1 && listEvidence.roundedShadows);
    await page.screenshot({ path: path.join(output, 'linuxdo-list-live.png') });

    stage = 'navigate to real topic';
    await firstTitle.click();
    await page.locator('h1 a.fancy-title').first().waitFor();
    const firstBody = page.locator('.topic-body .cooked').first();
    await firstBody.waitFor();
    assert.equal(await page.locator('#ldkh-settings').count(), 1);
    const bodyOriginal = await firstBody.evaluate(element => window.__testOriginalMarkup(element));
    stage = 'highlight real topic';
    const bodyText = (await firstBody.innerText()).trim();
    const bodyWord = Array.from(bodyText.split(/\s+/)[0]).slice(0, 4).join('');
    assert.ok(bodyWord.length > 0);
    actualState.rules.push({ id: 'live-body', name: '', keywords: [bodyWord], color: '#ff5cc9', enabled: true, scopes: ['body'] });
    await page.evaluate(next => window.__testRemoteUpdate(next), actualState);
    await page.waitForFunction(() => document.querySelector('[data-ldkh-rule="live-body"]'));
    await settle(page);
    const topicEvidence = await page.evaluate(() => ({
      headingTitles: document.querySelectorAll('h1 a.fancy-title').length,
      cookedPosts: document.querySelectorAll('.topic-body .cooked').length,
      bodyFragments: document.querySelectorAll('[data-ldkh-rule="live-body"]').length,
      titleFragments: document.querySelectorAll('h1 a.fancy-title [data-ldkh-rule="live-long"]').length,
    }));
    assert.ok(topicEvidence.bodyFragments > 0 && topicEvidence.titleFragments > 0);
    assert.equal(await firstBody.evaluate(element => window.__testOriginalMarkup(element)), bodyOriginal);
    assert.deepEqual(scriptErrors, []);
    await page.screenshot({ path: path.join(output, 'linuxdo-topic-live.png') });
    await page.locator('#ldkh-settings').getByRole('button', { name: '打开关键词高亮设置' }).click();
    assert.equal(await page.locator('#ldkh-settings').getByRole('dialog').isVisible(), true);
    await page.locator('#ldkh-settings').getByRole('dialog').screenshot({ path: path.join(output, 'linuxdo-settings-live.png') });
    const result = { result: 'passed', browser: 'chrome', site: 'https://linux.do/', topicUrl: page.url(), checks: ['real list DOM', 'real SPA navigation', 'real topic title', 'real cooked post', 'original content and elements preserved', 'settings dialog'], listEvidence, topicEvidence, scriptErrors };
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
