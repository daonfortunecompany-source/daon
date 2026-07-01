import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const outDir = '/mnt/user-data/outputs/daon_faq_mobile_fix_20260701';
fs.mkdirSync(outDir, { recursive: true });

const results = { url: 'http://127.0.0.1:3102/', checks: {}, perItem: [], errors: [] };
let browser;

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 1180 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(25000);
  page.setDefaultNavigationTimeout(25000);

  await page.goto(results.url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#faq');
  await page.waitForTimeout(1200);

  results.checks.pageLoaded = await page.locator('body').isVisible();
  results.checks.freeFormVisible = await page.locator('#fortuneForm').isVisible();
  results.checks.faqVisible = await page.locator('#faq').isVisible();

  const faqSection = page.locator('#faq');
  await faqSection.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(outDir, 'faq-closed-mobile.png'), timeout: 40000, animations: 'disabled' });

  const faqItems = page.locator('#faq .faq-item');
  const count = await faqItems.count();
  results.checks.faqItemCount = count;

  let allClosedClean = true;
  let allOpenVisible = true;
  let allIconsSwitch = true;

  for (let i = 0; i < count; i += 1) {
    const item = faqItems.nth(i);
    const button = item.locator('.faq-question');
    const title = (await button.locator('span').first().innerText()).trim();

    await item.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);

    const closedState = await page.evaluate((el) => {
      const wrap = el.querySelector('.faq-answer-wrap');
      const icon = el.querySelector('.faq-toggle-icon');
      const btn = el.querySelector('.faq-question');
      return {
        clientHeight: wrap ? wrap.clientHeight : -1,
        scrollHeight: wrap ? wrap.scrollHeight : -1,
        text: icon ? icon.textContent : '',
        expanded: btn ? btn.getAttribute('aria-expanded') : null,
      };
    }, await item.elementHandle());

    const closedOk = closedState.clientHeight === 0 && closedState.text === '+' && closedState.expanded === 'false';
    allClosedClean = allClosedClean && closedOk;

    await button.click();
    await page.waitForTimeout(500);

    const openState = await page.evaluate((el) => {
      const wrap = el.querySelector('.faq-answer-wrap');
      const answer = el.querySelector('.faq-answer');
      const icon = el.querySelector('.faq-toggle-icon');
      const btn = el.querySelector('.faq-question');
      return {
        clientHeight: wrap ? wrap.clientHeight : -1,
        scrollHeight: wrap ? wrap.scrollHeight : -1,
        icon: icon ? icon.textContent : '',
        expanded: btn ? btn.getAttribute('aria-expanded') : null,
        answerHeight: answer ? answer.scrollHeight : -1,
      };
    }, await item.elementHandle());

    const heightGap = Math.abs(openState.scrollHeight - openState.clientHeight);
    const openOk = openState.clientHeight > 0 && openState.scrollHeight > 0 && openState.answerHeight > 0 && heightGap <= 24 && openState.expanded === 'true';
    const iconOk = openState.icon === '−';
    allOpenVisible = allOpenVisible && openOk;
    allIconsSwitch = allIconsSwitch && iconOk;

    if (i === 1) {
      await item.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outDir, 'faq-refund-open-mobile.png'), timeout: 40000, animations: 'disabled' });
    }
    if (i === 2) {
      await item.scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outDir, 'faq-premium-open-mobile.png'), timeout: 40000, animations: 'disabled' });
    }

    results.perItem.push({ title, closedState, openState, heightGap, closedOk, openOk, iconOk });
  }

  results.checks.closedStateFullyHidden = allClosedClean;
  results.checks.openStateFullyVisible = allOpenVisible;
  results.checks.iconsSwitchCorrectly = allIconsSwitch;

  const bodyText = await page.locator('body').innerText();
  results.checks.noDevTempTextVisible = !(/demo-preview|데모 미리보기|dummy|mock|테스트용|임시 문구/i.test(bodyText));
} catch (error) {
  results.errors.push(String(error?.stack || error));
} finally {
  fs.writeFileSync(path.join(outDir, 'qa_results.json'), JSON.stringify(results, null, 2), 'utf-8');
  if (browser) await browser.close();
}

process.exit(0);
