import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const outDir = '/mnt/user-data/outputs/daon_faq_update_20260701';
fs.mkdirSync(outDir, { recursive: true });

const results = {
  url: 'http://127.0.0.1:3100/',
  checks: {},
  errors: []
};

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 1200 }, deviceScaleFactor: 2 });
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(20000);

  await page.goto('http://127.0.0.1:3100/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#faq');
  await page.waitForTimeout(1200);

  results.checks.pageLoaded = await page.locator('body').isVisible();
  results.checks.freeFormVisible = await page.locator('#fortuneForm').isVisible();

  const faqSection = page.locator('#faq');
  await faqSection.scrollIntoViewIfNeeded();
  results.checks.faqVisible = await faqSection.isVisible();

  const refundButton = page.getByRole('button', { name: '환불이 가능한가요?' });
  const premiumButton = page.getByRole('button', { name: '프리미엄 상세 사주풀이를 소개해 주세요' });
  results.checks.refundQuestionExists = await refundButton.isVisible();
  results.checks.premiumQuestionExists = await premiumButton.isVisible();

  await refundButton.click();
  await page.waitForTimeout(300);
  await premiumButton.click();
  await page.waitForTimeout(300);

  const refundText = await page.locator('#faq .faq-item').nth(1).innerText();
  const premiumText = await page.locator('#faq .faq-item').nth(2).innerText();
  const bodyText = await page.locator('body').innerText();

  results.checks.refundContainsRequired = [
    '환불 가능 조건',
    '환불 불가 조건',
    '환불 접수 방법',
    '2~3영업일 내로 환불이 진행됩니다.'
  ].every(t => refundText.includes(t));

  results.checks.premiumContainsRequired = [
    '열심히 살고 있는데, 왜 같은 고민이 반복될까요?',
    '사주의 핵심은 ‘해석’에 있습니다.',
    '1인 상세 사주풀이 – 49,800원',
    '2인 상세 사주풀이 – 79,800원',
    'PDF 풀이서는 이렇게 전달됩니다.'
  ].every(t => premiumText.includes(t));

  results.checks.noMarkdownArtifactsInFaq = !(/(^|\n)\s*#{1,6}\s|\n---\n|\*\*/m.test(refundText + '\n' + premiumText));
  results.checks.noDevOrTempTextVisible = !(/demo-preview|데모 미리보기|dummy|mock|test|placeholder/i.test(bodyText));
  results.checks.noOldFallbackTextVisible = !(/대체 분포 기준|대체 데이터로 구성/i.test(bodyText));

  await page.screenshot({ path: path.join(outDir, 'faq-mobile-viewport.png'), timeout: 40000, animations: 'disabled' });
} catch (error) {
  results.errors.push(String(error && error.stack ? error.stack : error));
} finally {
  fs.writeFileSync(path.join(outDir, 'qa_results.json'), JSON.stringify(results, null, 2), 'utf-8');
  if (browser) await browser.close();
}
process.exit(0);
