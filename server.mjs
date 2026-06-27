import 'dotenv/config';
import express from 'express';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STORAGE_DIR = path.resolve(__dirname, process.env.REPORT_STORAGE_DIR || './storage');
const ORDERS_DIR = path.join(STORAGE_DIR, 'orders');
const REPORTS_DIR = path.join(STORAGE_DIR, 'reports');
const LOGS_DIR = path.join(STORAGE_DIR, 'logs');
const TMP_DIR = path.join(STORAGE_DIR, 'tmp');
const PUBLIC_DIR = path.join(__dirname, 'public');
const FONT_REGULAR = path.join(__dirname, 'fonts', 'NanumGothic.ttf');
const FONT_BOLD = path.join(__dirname, 'fonts', 'NanumBarunGothicBold.ttf');
const generatingOrders = new Set();
const LUCKY_API_BASE_URL = (process.env.LUCKY_API_BASE_URL || 'https://luckyloveme.com').replace(/\/$/, '');
const DEFAULT_PERIOD_YEAR = Number(process.env.DEFAULT_PERIOD_YEAR || 2026);
const DEFAULT_PERIOD_MONTH = Number(process.env.DEFAULT_PERIOD_MONTH || 6);
const DEFAULT_PERIOD_DAY = Number(process.env.DEFAULT_PERIOD_DAY || 1);
const ALLOW_LOCAL_FALLBACK = process.env.ALLOW_LOCAL_FALLBACK != null
  ? String(process.env.ALLOW_LOCAL_FALLBACK).toLowerCase() === 'true'
  : String(process.env.USE_MOCK_DATA || 'false').toLowerCase() === 'true';

const CONFIG = {
  lucky: {
    apiKey: process.env.LUCKY_API_KEY || process.env.LUCKY_API_HEADER_VALUE || '',
    authMode: process.env.LUCKY_API_AUTH_MODE || 'header',
    authHeader: process.env.LUCKY_API_AUTH_HEADER || process.env.LUCKY_API_HEADER_NAME || 'X-SAJU-BOOK-API-KEY',
    baseUrl: LUCKY_API_BASE_URL,
    mansaeUrl: process.env.LUCKY_MANSAE_URL || `${LUCKY_API_BASE_URL}/api/mansae`,
    sajuUrl: process.env.LUCKY_SAJU_URL || `${LUCKY_API_BASE_URL}/api/saju-full-analysis`,
    compatibilityUrl: process.env.LUCKY_COMPATIBILITY_URL || `${LUCKY_API_BASE_URL}/api/compatibility-saju`,
    periodUrl: process.env.LUCKY_PERIOD_URL || `${LUCKY_API_BASE_URL}/api/period-fortune-saju`,
    defaultPeriodYear: DEFAULT_PERIOD_YEAR,
    defaultPeriodMonth: DEFAULT_PERIOD_MONTH,
    defaultPeriodDay: DEFAULT_PERIOD_DAY
  },
  ai: {
    apiKey: process.env.KIE_AI_API_KEY || '',
    baseUrl: (process.env.AI_API_BASE_URL || 'https://api.kie.ai').replace(/\/$/, ''),
    path: process.env.AI_API_PATH || '/gpt-5-2/v1/chat/completions',
    style: process.env.AI_API_STYLE || 'chat_completions',
    model: process.env.AI_MODEL || 'gpt-5-2',
    temperature: Number(process.env.AI_TEMPERATURE || 0.7)
  },
  payapp: {
    apiUrl: process.env.PAYAPP_API_URL || 'https://api.payapp.kr/oapi/apiLoad.html',
    userid: process.env.PAYAPP_USERID || '',
    shopname: process.env.PAYAPP_SHOPNAME || '일상사주',
    linkKey: process.env.PAYAPP_LINK_KEY || '',
    linkValue: process.env.PAYAPP_LINK_VALUE || '',
    feedbackPath: process.env.PAYAPP_FEEDBACK_PATH || '/api/payapp/feedback',
    returnPath: process.env.PAYAPP_RETURN_PATH || '/report-status.html',
    mock: String(process.env.PAYAPP_MOCK || 'false').toLowerCase() === 'true'
  },
  product: {
    singlePrice: Number(process.env.REPORT_PRICE_SINGLE || 18900),
    compatibilityPrice: Number(process.env.REPORT_PRICE_COMPATIBILITY || 36000),
    singleName: process.env.REPORT_PRODUCT_SINGLE || '프리미엄 사주 리포트',
    compatibilityName: process.env.REPORT_PRODUCT_COMPATIBILITY || '프리미엄 사주 리포트 (2인,궁합포함)'
  },
  allowLocalFallback: ALLOW_LOCAL_FALLBACK
};

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

await ensureDirectories();

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    service: 'daon-premium-saju-service',
    payappReady: Boolean(CONFIG.payapp.userid && CONFIG.payapp.linkValue),
    luckyConfigured: Boolean(CONFIG.lucky.apiKey),
    aiConfigured: Boolean(CONFIG.ai.apiKey),
    time: new Date().toISOString()
  });
});

app.post('/api/saju/summary', async (req, res) => {
  try {
    console.log('[FREE SUMMARY] request received');
    const payload = normalizeApplicant(req.body || {});
    const luckyPayload = toLuckyFlatPayload(payload);
    let mansaeData = null;
    let source = 'lucky';
    let usingFallback = false;
    try {
      mansaeData = await callLuckyApi(CONFIG.lucky.mansaeUrl, [luckyPayload], 'mansae');
    } catch (error) {
      await appendLog('summary_api_warning', { error: error.message });
      if (!CONFIG.allowLocalFallback) {
        console.log('[LUCKY API] using fallback: false');
        throw error;
      }
      usingFallback = true;
      source = String(process.env.USE_MOCK_DATA || 'false').toLowerCase() === 'true' ? 'mock' : 'local';
    }
    if (!mansaeData) {
      usingFallback = true;
      source = source === 'lucky'
        ? (String(process.env.USE_MOCK_DATA || 'false').toLowerCase() === 'true' ? 'mock' : 'local')
        : source;
    }
    console.log(`[LUCKY API] using fallback: ${usingFallback}`);
    console.log(`[FREE SUMMARY] response source: ${source}`);
    const result = buildFreeSummary(payload, mansaeData, { source, usingFallback });
    res.json({ result });
  } catch (error) {
    res.status(400).json({ error: error.message || '요약 결과를 생성하지 못했습니다.' });
  }
});

app.post('/api/orders/create', async (req, res) => {
  try {
    const input = normalizeOrderInput(req.body || {});
    validateOrderInput(input);
    const product = determineProduct(input);
    const orderId = `ord_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const order = {
      id: orderId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'created',
      product,
      applicant: input.applicant,
      partner: input.partner,
      compatibilityRequested: input.compatibilityRequested,
      warnings: buildInputWarnings(input),
      payment: {
        price: product.price,
        productName: product.name,
        mulNo: null,
        payState: 1,
        method: CONFIG.payapp.mock ? 'mock' : 'payapp'
      },
      artifacts: {},
      logs: []
    };
    await saveOrder(order);
    const payment = await createPaymentRequest(order);
    order.payment = { ...order.payment, ...payment };
    order.status = 'payment_pending';
    order.updatedAt = new Date().toISOString();
    order.logs.push(logLine('payment_request_created', { mulNo: payment.mulNo || null }));
    await saveOrder(order);

    res.json({
      ok: true,
      orderId,
      paymentUrl: payment.payUrl,
      statusUrl: `${BASE_URL}/report-status.html?order=${encodeURIComponent(orderId)}`
    });
  } catch (error) {
    await appendLog('order_create_error', { message: error.message });
    res.status(400).json({ error: error.message || '주문 생성에 실패했습니다.' });
  }
});

app.all('/api/payapp/feedback', async (req, res) => {
  const incoming = { ...req.query, ...req.body };
  try {
    const orderId = String(incoming.var1 || '').trim();
    if (!orderId) throw new Error('주문 식별값(var1)이 없습니다.');
    const order = await readOrder(orderId);
    if (!order) throw new Error('주문을 찾을 수 없습니다.');

    const linkValue = String(incoming.linkval || '');
    if (CONFIG.payapp.linkValue && linkValue && CONFIG.payapp.linkValue !== linkValue) {
      throw new Error('PayApp linkval 검증에 실패했습니다.');
    }

    const payState = Number(incoming.pay_state || incoming.payState || 0);
    const price = Number(incoming.price || 0);
    if (price && price !== order.payment.price) {
      throw new Error('결제 금액 검증에 실패했습니다.');
    }

    order.payment = {
      ...order.payment,
      payState,
      mulNo: incoming.mul_no || order.payment.mulNo,
      recvphone: incoming.recvphone || order.applicant.phone,
      payUrl: incoming.payurl || order.payment.payUrl || null,
      lastFeedbackAt: new Date().toISOString()
    };

    if (payState === 4) {
      order.status = order.status === 'ready' ? 'ready' : 'payment_success';
      order.logs.push(logLine('payment_success', { payState, mulNo: order.payment.mulNo }));
      await saveOrder(order);
      triggerReportGeneration(order.id);
    } else if ([8, 9, 32, 64, 70, 71].includes(payState)) {
      order.status = 'payment_cancelled';
      order.logs.push(logLine('payment_cancelled', { payState }));
      await saveOrder(order);
    } else if (payState === 10) {
      order.status = 'payment_pending';
      order.logs.push(logLine('payment_waiting', { payState }));
      await saveOrder(order);
    } else {
      order.logs.push(logLine('payment_feedback_received', { payState }));
      await saveOrder(order);
    }

    res.status(200).send('SUCCESS');
  } catch (error) {
    await appendLog('payapp_feedback_error', { message: error.message, incoming });
    res.status(200).send('FAIL');
  }
});

app.get('/api/orders/:orderId/status', async (req, res) => {
  const order = await readOrder(req.params.orderId);
  if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });

  res.json({
    orderId: order.id,
    status: order.status,
    message: buildStatusMessage(order),
    downloadUrl: order.status === 'ready' ? `${BASE_URL}/api/orders/${encodeURIComponent(order.id)}/report.pdf` : null,
    productName: order.product.name,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  });
});

app.get('/api/orders/:orderId/report.pdf', async (req, res) => {
  const order = await readOrder(req.params.orderId);
  if (!order || !order.artifacts?.pdfPath) {
    return res.status(404).json({ error: '리포트 파일을 찾을 수 없습니다.' });
  }
  const filePath = order.artifacts.pdfPath;
  if (!fsSync.existsSync(filePath)) {
    return res.status(404).json({ error: '리포트 파일이 존재하지 않습니다.' });
  }
  res.download(filePath, path.basename(filePath));
});

app.get('/mock-pay/:orderId', async (req, res) => {
  const order = await readOrder(req.params.orderId);
  if (!order) return res.status(404).send('Order not found');
  res.send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock Pay</title><style>body{font-family:sans-serif;background:#f7f3ee;padding:24px}.card{max-width:420px;margin:0 auto;background:#fff;padding:24px;border-radius:20px;border:1px solid #eadfd2}.btn{display:block;margin-top:12px;padding:14px 16px;border-radius:14px;text-align:center;text-decoration:none;font-weight:700}.ok{background:#cf8f7a;color:#fff}.cancel{background:#fff;border:1px solid #eadfd2;color:#352c29}</style></head><body><div class="card"><h1>Mock 결제 페이지</h1><p>${escapeHtml(order.product.name)} / ${order.product.price.toLocaleString('ko-KR')}원</p><a class="btn ok" href="/mock-pay/${encodeURIComponent(order.id)}/complete">결제 성공 처리</a><a class="btn cancel" href="/mock-pay/${encodeURIComponent(order.id)}/cancel">결제 취소 처리</a></div></body></html>`);
});

app.get('/mock-pay/:orderId/complete', async (req, res) => {
  const order = await readOrder(req.params.orderId);
  if (!order) return res.status(404).send('Order not found');
  order.status = 'payment_success';
  order.payment.payState = 4;
  order.payment.mulNo = order.payment.mulNo || `mock_${Date.now()}`;
  order.logs.push(logLine('mock_payment_success', {}));
  await saveOrder(order);
  triggerReportGeneration(order.id);
  res.redirect(`${BASE_URL}/report-status.html?order=${encodeURIComponent(order.id)}`);
});

app.get('/mock-pay/:orderId/cancel', async (req, res) => {
  const order = await readOrder(req.params.orderId);
  if (!order) return res.status(404).send('Order not found');
  order.status = 'payment_cancelled';
  order.payment.payState = 9;
  order.logs.push(logLine('mock_payment_cancelled', {}));
  await saveOrder(order);
  res.redirect(`${BASE_URL}/report-status.html?order=${encodeURIComponent(order.id)}`);
});

app.listen(PORT, () => {
  console.log(`Daon Premium Saju service listening on ${PORT}`);
});

function triggerReportGeneration(orderId) {
  setTimeout(() => {
    generatePremiumReport(orderId).catch(async (error) => {
      await appendLog('report_generation_fatal', { orderId, message: error.message });
    });
  }, 50);
}

async function generatePremiumReport(orderId) {
  if (generatingOrders.has(orderId)) return;
  generatingOrders.add(orderId);
  try {
    const order = await readOrder(orderId);
    if (!order || order.status === 'ready') return;

    order.status = 'generating';
    order.updatedAt = new Date().toISOString();
    order.logs.push(logLine('generation_started', {}));
    await saveOrder(order);

    const warnings = [...(order.warnings || [])];
    const apiSnapshots = {};
    const applicantPayload = toLuckyFlatPayload(order.applicant);

    const mansaeResult = await optionalApiCall('mansae', CONFIG.lucky.mansaeUrl, [applicantPayload], warnings, true);
    if (mansaeResult.data) apiSnapshots.mansae = mansaeResult.data;

    const sajuCandidates = [
      { ...applicantPayload },
      { ...applicantPayload, fields: ['daeun', 'seun', 'sinsal', 'gyeokgukYongsin'] }
    ];
    const sajuResult = await optionalApiCall('saju', CONFIG.lucky.sajuUrl, sajuCandidates, warnings, true);
    if (sajuResult.data) apiSnapshots.saju = sajuResult.data;

    const periodCandidates = [
      { ...applicantPayload, years: 5, months: 6, defaultYear: CONFIG.lucky.defaultPeriodYear, defaultMonth: CONFIG.lucky.defaultPeriodMonth, defaultDay: CONFIG.lucky.defaultPeriodDay },
      { ...applicantPayload, futureYears: 5, futureMonths: 6, defaultYear: CONFIG.lucky.defaultPeriodYear, defaultMonth: CONFIG.lucky.defaultPeriodMonth, defaultDay: CONFIG.lucky.defaultPeriodDay },
      { ...applicantPayload, rangeYears: 5, rangeMonths: 6, defaultYear: CONFIG.lucky.defaultPeriodYear, defaultMonth: CONFIG.lucky.defaultPeriodMonth, defaultDay: CONFIG.lucky.defaultPeriodDay },
      { ...applicantPayload, years: 5, months: 6, baseYear: CONFIG.lucky.defaultPeriodYear, baseMonth: CONFIG.lucky.defaultPeriodMonth, baseDay: CONFIG.lucky.defaultPeriodDay },
      { ...applicantPayload, years: 5, months: 6, startYear: CONFIG.lucky.defaultPeriodYear, startMonth: CONFIG.lucky.defaultPeriodMonth, startDay: CONFIG.lucky.defaultPeriodDay }
    ];
    const periodResult = await optionalApiCall('period', CONFIG.lucky.periodUrl, periodCandidates, warnings, false);
    if (periodResult.data) apiSnapshots.period = periodResult.data;

    if (shouldCallCompatibility(order)) {
      const partnerPayload = toLuckyFlatPayload(order.partner);
      const compatibilityCandidates = [
        { person1: applicantPayload, person2: partnerPayload, note: order.partner?.memo || '' },
        { me: applicantPayload, partner: partnerPayload, note: order.partner?.memo || '' },
        { applicant: applicantPayload, partner: partnerPayload, note: order.partner?.memo || '' },
        { ...applicantPayload, partner: partnerPayload, note: order.partner?.memo || '' }
      ];
      const compatibilityResult = await optionalApiCall('compatibility', CONFIG.lucky.compatibilityUrl, compatibilityCandidates, warnings, false);
      if (compatibilityResult.data) apiSnapshots.compatibility = compatibilityResult.data;
    }

    if (!apiSnapshots.saju && !apiSnapshots.mansae) {
      if (CONFIG.allowLocalFallback) {
        warnings.push('핵심 사주 API 응답을 받지 못해 내부 대체 요약 구조로 PDF를 생성했습니다. 운영 환경에서는 실제 API 키와 인증 설정을 반드시 확인해 주세요.');
      } else {
        throw new Error('핵심 사주 데이터 호출에 실패했습니다.');
      }
    }

    const promptPayload = buildAiPromptPayload(order, apiSnapshots, warnings);
    const aiSections = await generateAiSections(promptPayload);
    const pdfFilePath = await renderPremiumPdf(order, promptPayload, aiSections);

    order.status = 'ready';
    order.updatedAt = new Date().toISOString();
    order.artifacts.pdfPath = pdfFilePath;
    order.artifacts.aiSections = aiSections;
    order.artifacts.promptPayload = promptPayload;
    order.logs.push(logLine('generation_completed', { pdfFilePath }));
    await saveOrder(order);
  } catch (error) {
    const order = await readOrder(orderId);
    if (order) {
      order.status = 'failed';
      order.updatedAt = new Date().toISOString();
      order.logs.push(logLine('generation_failed', { message: error.message }));
      await saveOrder(order);
    }
    await appendLog('generation_failed', { orderId, message: error.message });
  } finally {
    generatingOrders.delete(orderId);
  }
}

async function optionalApiCall(label, url, payloadCandidates, warnings, critical = false) {
  try {
    const data = await callLuckyApi(url, payloadCandidates, label);
    return { data };
  } catch (error) {
    warnings.push(`${label} API 호출 실패: ${error.message}`);
    if (critical) await appendLog('critical_api_failure', { label, message: error.message });
    return { data: null, error };
  }
}

async function callLuckyApi(url, payloadCandidates, label) {
  if (!CONFIG.lucky.apiKey) {
    throw new Error('LUCKY_API_KEY가 설정되지 않았습니다.');
  }
  console.log('[LUCKY API] request start');
  const candidates = Array.isArray(payloadCandidates) ? payloadCandidates : [payloadCandidates];
  const authVariants = resolveLuckyAuthVariants();
  let lastError = new Error(`${label} API 호출 실패`);

  for (const payload of candidates) {
    for (const authVariant of authVariants) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        let requestUrl = url;
        const body = JSON.stringify(payload);
        if (authVariant.mode === 'header') {
          headers[authVariant.header] = CONFIG.lucky.apiKey;
        } else if (authVariant.mode === 'bearer') {
          headers.Authorization = `Bearer ${CONFIG.lucky.apiKey}`;
        } else if (authVariant.mode === 'query') {
          const u = new URL(url);
          u.searchParams.set('apiKey', CONFIG.lucky.apiKey);
          requestUrl = u.toString();
        }
        const response = await fetch(requestUrl, { method: 'POST', headers, body });
        const text = await response.text();
        console.log(`[LUCKY API] status: ${response.status}`);
        if (!response.ok) {
          await appendLog('lucky_api_attempt_failed', {
            label,
            url: requestUrl,
            authMode: authVariant.mode,
            authHeader: authVariant.mode === 'header' ? authVariant.header : null,
            status: response.status,
            bodyPreview: text.slice(0, 160)
          });
          lastError = new Error(`${label} API ${response.status}: ${text.slice(0, 160)}`);
          continue;
        }
        return safeJsonParse(text);
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError;
}

function resolveLuckyAuthVariants() {
  const mode = CONFIG.lucky.authMode;
  if (mode === 'header') return [{ mode: 'header', header: CONFIG.lucky.authHeader }];
  if (mode === 'bearer') return [{ mode: 'bearer' }];
  if (mode === 'query') return [{ mode: 'query' }];
  return [
    { mode: 'header', header: CONFIG.lucky.authHeader },
    { mode: 'header', header: 'X-API-KEY' },
    { mode: 'header', header: 'x-api-key' },
    { mode: 'bearer' },
    { mode: 'query' }
  ];
}

async function createPaymentRequest(order) {
  if (CONFIG.payapp.mock) {
    return {
      mulNo: `mock_${Date.now()}`,
      payUrl: `${BASE_URL}/mock-pay/${encodeURIComponent(order.id)}`
    };
  }
  if (!CONFIG.payapp.userid) throw new Error('PAYAPP_USERID가 설정되지 않았습니다.');

  const form = new URLSearchParams({
    cmd: 'payrequest',
    userid: CONFIG.payapp.userid,
    shopname: CONFIG.payapp.shopname,
    goodname: order.product.name,
    price: String(order.product.price),
    recvphone: order.applicant.phone,
    feedbackurl: `${BASE_URL}${CONFIG.payapp.feedbackPath}`,
    returnurl: `${BASE_URL}${CONFIG.payapp.returnPath}?order=${encodeURIComponent(order.id)}`,
    var1: order.id,
    var2: order.applicant.email
  });

  const response = await fetch(CONFIG.payapp.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: form.toString()
  });
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`PayApp 요청 실패: ${response.status}`);
  }
  const parsed = Object.fromEntries(new URLSearchParams(raw));
  if (String(parsed.state) !== '1' || !parsed.payurl) {
    throw new Error(parsed.errorMessage || 'PayApp 결제 URL을 생성하지 못했습니다.');
  }
  return {
    mulNo: parsed.mul_no || null,
    payUrl: parsed.payurl
  };
}

function determineProduct(input) {
  const compatibility = Boolean(input.compatibilityRequested || hasPartnerCoreFields(input.partner));
  return compatibility
    ? { type: 'compatibility', name: CONFIG.product.compatibilityName, price: CONFIG.product.compatibilityPrice }
    : { type: 'single', name: CONFIG.product.singleName, price: CONFIG.product.singlePrice };
}

function buildInputWarnings(input) {
  const warnings = [];
  const birthTime = input.applicant.birthTime || '';
  if (!birthTime) warnings.push('출생 시간을 모름으로 선택하여 시주 해석은 보수적으로 정리합니다.');
  if (/^(23|00|01):/.test(birthTime)) warnings.push('야자시/조자시 구간 여부를 확인하는 메모를 함께 포함합니다.');
  if (input.applicant.calendarType === 'lunar' && input.applicant.isLeapMonth === 'unknown') warnings.push('음력 생일이며 윤달 여부가 불확실해 확인 메모를 포함합니다.');
  if (input.partner?.memo && !hasPartnerCoreFields(input.partner)) warnings.push('상대 정보가 일부만 입력되어 궁합 API 대신 관계 관련 참고 조언 중심으로 정리합니다.');
  return warnings;
}

function buildStatusMessage(order) {
  switch (order.status) {
    case 'payment_pending':
      return '결제창에서 결제를 완료하면 자동으로 리포트 생성 단계로 넘어갑니다.';
    case 'payment_success':
      return '결제가 확인되었습니다. API 데이터와 해설을 정리할 준비를 하고 있습니다.';
    case 'generating':
      return '리포트를 생성 중입니다. 만세력, 사주, 시기별 운세 데이터를 바탕으로 PDF를 정리하고 있습니다.';
    case 'ready':
      return '프리미엄 리포트가 준비되었습니다. 아래 다운로드 버튼으로 결과물을 받으실 수 있습니다.';
    case 'payment_cancelled':
      return '결제가 취소되어 결과물 생성이 진행되지 않았습니다.';
    case 'failed':
      return '리포트 생성 중 문제가 발생했습니다. 로그가 저장되었고 재처리 또는 관리자 확인이 가능합니다.';
    default:
      return '주문 상태를 확인하고 있습니다.';
  }
}

function normalizeOrderInput(input) {
  return {
    compatibilityRequested: Boolean(input.compatibilityRequested),
    applicant: normalizeApplicant(input.applicant || {}),
    partner: input.partner ? normalizeApplicant(input.partner, true) : null
  };
}

function normalizeApplicant(raw, isPartner = false) {
  const birthYear = cleanDigits(raw.birthYear || raw.year || '');
  const birthMonth = cleanDigits(raw.birthMonth || raw.month || '');
  const birthDay = cleanDigits(raw.birthDay || raw.day || '');
  const birthTimeUnknown = raw.birthTimeUnknown === true || raw.birthTimeUnknown === 'true' || raw.birthTimeUnknown === 'unknown';
  const birthHour = cleanDigits(raw.birthHour || '').slice(0, 2);
  const birthMinute = cleanDigits(raw.birthMinute || '').slice(0, 2);
  const combinedBirthTime = birthHour || birthMinute ? `${birthHour.padStart(2, '0')}:${birthMinute.padStart(2, '0')}` : '';
  return {
    name: String(raw.name || '').trim(),
    gender: raw.gender === 'male' ? 'male' : raw.gender === 'female' ? 'female' : '',
    birthYear,
    birthMonth,
    birthDay,
    birthTime: birthTimeUnknown ? '' : normalizeTime(raw.birthTime || combinedBirthTime || ''),
    birthTimeUnknown,
    calendarType: normalizeCalendarType(raw.calendarType || raw.calendar || 'solar'),
    isLeapMonth: normalizeLeap(raw.isLeapMonth),
    phone: isPartner ? '' : cleanDigits(raw.phone || raw.buyerPhone || ''),
    email: isPartner ? '' : String(raw.email || '').trim(),
    concern: isPartner ? '' : String(raw.concern || '').trim(),
    memo: isPartner ? String(raw.memo || raw.partnerMemo || '').trim() : ''
  };
}

function validateOrderInput(input) {
  const a = input.applicant;
  if (!a.name) throw new Error('이름을 입력해 주세요.');
  if (!a.gender) throw new Error('성별을 선택해 주세요.');
  if (!a.birthYear || !a.birthMonth || !a.birthDay) throw new Error('생년월일을 입력해 주세요.');
  if (!a.phone) throw new Error('연락처를 입력해 주세요.');
  if (!a.email) throw new Error('이메일을 입력해 주세요.');
  if (input.compatibilityRequested && !hasPartnerCoreFields(input.partner)) {
    throw new Error('궁합 포함 리포트는 상대방 핵심 정보를 함께 입력해 주세요.');
  }
}

function hasPartnerCoreFields(partner) {
  return Boolean(partner && partner.name && partner.gender && partner.birthYear && partner.birthMonth && partner.birthDay);
}

function shouldCallCompatibility(order) {
  return hasPartnerCoreFields(order.partner);
}

function toLuckyFlatPayload(person) {
  const [hour, minute] = String(person.birthTime || '').split(':');
  return {
    birthYear: person.birthYear,
    birthMonth: String(Number(person.birthMonth || 0) || ''),
    birthDay: String(Number(person.birthDay || 0) || ''),
    birthHour: hour ? String(Number(hour)) : '',
    birthMinute: minute ? String(Number(minute)) : '',
    calendarType: person.calendarType === 'lunar' ? '음력' : '양력',
    gender: person.gender,
    isLeapMonth: person.isLeapMonth === true,
    useYajasiRule: true
  };
}

function normalizeCalendarType(value) {
  return value === 'lunar' || value === '음력' ? 'lunar' : 'solar';
}

function normalizeLeap(value) {
  if (value === true || value === 'true') return true;
  if (value === 'unknown') return 'unknown';
  return false;
}

function normalizeTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{1,2}:\d{2}$/.test(raw)) return raw.length === 4 ? `0${raw}` : raw;
  const digits = cleanDigits(raw);
  if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
  if (digits.length === 3) return `0${digits[0]}:${digits.slice(1, 3)}`;
  return '';
}

function cleanDigits(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function buildFreeSummary(payload, mansaeData, meta = {}) {
  const pillars = extractPillars(mansaeData, payload);
  const elements = extractDistribution(mansaeData, ['오행', 'five', 'element']) || defaultElementDistribution(payload);
  const tenGods = extractDistribution(mansaeData, ['십성', 'tenGod', 'ten']) || defaultTenGodDistribution(payload);
  const name = payload.name || '사용자';
  const dominantElement = Object.entries(elements).sort((a, b) => b[1] - a[1])[0]?.[0] || '목';
  const dominantGod = Object.entries(tenGods).sort((a, b) => b[1] - a[1])[0]?.[0] || '비견';
  const source = meta.source || (mansaeData ? 'lucky' : 'local');
  return {
    source,
    usingFallback: Boolean(meta.usingFallback),
    metrics: {
      fiveElementsUnit: 'score',
      tenGodsUnit: 'score',
      chartDisplay: 'normalized-percent'
    },
    year: pillars.year,
    month: pillars.month,
    day: pillars.day,
    hour: pillars.hour,
    pillarDetails: buildPillarDetails(pillars, mansaeData),
    fiveElements: elements,
    tenGods,
    tags: [`${dominantElement} 기운`, `${dominantGod} 중심`, payload.calendarType === 'lunar' ? '음력 기준' : '양력 기준'],
    summary: `${name}님은 기본적으로 ${dominantElement} 기운이 또렷하고 ${dominantGod} 성향이 전면에 드러나는 흐름으로 읽힙니다.`,
    trait: `${name}님은 자신의 판단 기준이 분명한 편이며, 한번 방향을 정하면 끝까지 밀어붙이는 힘이 있습니다. 다만 피로가 쌓일 때는 감정 기복이 커질 수 있어 템포 조절이 중요합니다.`,
    love: `관계에서는 솔직함과 안정감을 동시에 원합니다. 가까워질수록 속도를 맞춰주는 사람이 잘 맞고, 말보다 행동에서 신뢰를 확인하려는 경향이 있습니다.`,
    work: `일과 재물에서는 당장의 성과보다 흐름을 길게 보는 편이 유리합니다. 익숙한 영역에서 실력을 쌓되, 결정적인 시점에는 스스로 주도권을 잡는 방식이 좋습니다.`,
    ui: {
      sourceLabel: source === 'lucky' ? 'Lucky API' : source === 'mock' ? 'MOCK DATA' : 'LOCAL FALLBACK',
      intro: '입력한 생년월일시를 바탕으로 사주 원국, 오행/십성 경향, 핵심 해석을 한 화면에 정리했습니다.',
      summaryTitle: '무료 요약 결과',
      summaryBody: `${name}님의 무료 요약 결과입니다. 아래에서 사주 원국과 핵심 해석을 함께 확인해보세요.`
    }
  };
}

function buildPillarDetails(pillars, rawData = null) {
  const maps = {
    stemHanja: { 갑: '甲', 을: '乙', 병: '丙', 정: '丁', 무: '戊', 기: '己', 경: '庚', 신: '辛', 임: '壬', 계: '癸' },
    branchHanja: { 자: '子', 축: '丑', 인: '寅', 묘: '卯', 진: '辰', 사: '巳', 오: '午', 미: '未', 신: '申', 유: '酉', 술: '戌', 해: '亥' },
    yinYangStem: { 갑: '양', 을: '음', 병: '양', 정: '음', 무: '양', 기: '음', 경: '양', 신: '음', 임: '양', 계: '음' },
    yinYangBranch: { 자: '양', 축: '음', 인: '양', 묘: '음', 진: '양', 사: '음', 오: '양', 미: '음', 신: '양', 유: '음', 술: '양', 해: '음' },
    ohaengStem: { 갑: '목', 을: '목', 병: '화', 정: '화', 무: '토', 기: '토', 경: '금', 신: '금', 임: '수', 계: '수' },
    ohaengBranch: { 자: '수', 축: '토', 인: '목', 묘: '목', 진: '토', 사: '화', 오: '화', 미: '토', 신: '금', 유: '금', 술: '토', 해: '수' }
  };
  const make = (pillar, pillarKey) => {
    const p = String(pillar || '--');
    const gan = p[0] || '-';
    const ji = p[1] || '-';
    const sipseong = extractPillarSipseong(rawData, pillarKey);
    return {
      hangul: p,
      hanja: `${maps.stemHanja[gan] || ''}${maps.branchHanja[ji] || ''}` || '-',
      eumyang: { gan: maps.yinYangStem[gan] || '-', ji: maps.yinYangBranch[ji] || '-' },
      ohaeng: { gan: maps.ohaengStem[gan] || '-', ji: maps.ohaengBranch[ji] || '-' },
      sipseong: { gan: sipseong.gan || '-', ji: sipseong.ji || '-' }
    };
  };
  return {
    year: make(pillars.year, 'year'),
    month: make(pillars.month, 'month'),
    day: make(pillars.day, 'day'),
    hour: make(pillars.hour, 'hour')
  };
}

function extractPillarSipseong(data, pillarKey) {
  if (!data || typeof data !== 'object') return { gan: '-', ji: '-' };
  const pillarNode = findValueByKeys(data, [pillarKey, `${pillarKey}Pillar`, `${pillarKey}Info`, `${pillarKey}柱`, `${pillarKey}주`]);
  const localized = pillarKey === 'year' ? '년' : pillarKey === 'month' ? '월' : pillarKey === 'day' ? '일' : '시';
  const gan = String(
    findValueByKeyPatterns(pillarNode || data, [
      [pillarKey, 'stem', 'tengod'],
      [pillarKey, 'gan', 'sipseong'],
      [pillarKey, 'heavenly', 'tengod'],
      [localized, '천간', '십성'],
      ['천간', '십성']
    ]) || '-'
  ).trim();
  const ji = String(
    findValueByKeyPatterns(pillarNode || data, [
      [pillarKey, 'branch', 'tengod'],
      [pillarKey, 'ji', 'sipseong'],
      [pillarKey, 'earthly', 'tengod'],
      [localized, '지지', '십성'],
      ['지지', '십성']
    ]) || '-'
  ).trim();
  return { gan, ji };
}

function findValueByKeyPatterns(root, patternGroups) {
  if (!root || typeof root !== 'object') return null;
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    for (const [key, value] of Object.entries(current)) {
      const lower = String(key).toLowerCase();
      if (patternGroups.some((group) => group.every((token) => lower.includes(String(token).toLowerCase())))) {
        return value;
      }
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function extractPillars(data, fallbackPerson) {
  const text = JSON.stringify(data || {});
  const direct = {
    year: findValueByKeys(data, ['yearPillar', 'year', 'yearGanji']),
    month: findValueByKeys(data, ['monthPillar', 'month', 'monthGanji']),
    day: findValueByKeys(data, ['dayPillar', 'day', 'dayGanji']),
    hour: findValueByKeys(data, ['hourPillar', 'hour', 'hourGanji'])
  };
  if (Object.values(direct).some(Boolean)) {
    return {
      year: normalizePillar(direct.year) || generatePillarSeed(fallbackPerson.birthYear, 0),
      month: normalizePillar(direct.month) || generatePillarSeed(fallbackPerson.birthMonth, 1),
      day: normalizePillar(direct.day) || generatePillarSeed(fallbackPerson.birthDay, 2),
      hour: normalizePillar(direct.hour) || generatePillarSeed((fallbackPerson.birthTime || '09:00').split(':')[0], 3)
    };
  }
  const matches = text.match(/[갑을병정무기경신임계][자축인묘진사오미신유술해]/g) || [];
  return {
    year: matches[0] || generatePillarSeed(fallbackPerson.birthYear, 0),
    month: matches[1] || generatePillarSeed(fallbackPerson.birthMonth, 1),
    day: matches[2] || generatePillarSeed(fallbackPerson.birthDay, 2),
    hour: matches[3] || generatePillarSeed((fallbackPerson.birthTime || '09:00').split(':')[0], 3)
  };
}

function normalizePillar(value) {
  const text = String(value || '').trim();
  const match = text.match(/[갑을병정무기경신임계][자축인묘진사오미신유술해]/);
  return match ? match[0] : '';
}

function generatePillarSeed(seedValue, offset = 0) {
  const stems = ['갑','을','병','정','무','기','경','신','임','계'];
  const branches = ['자','축','인','묘','진','사','오','미','신','유','술','해'];
  const seed = Number(seedValue || 1) + offset * 7;
  return `${stems[seed % stems.length]}${branches[seed % branches.length]}`;
}

function extractDistribution(data, keywords) {
  if (!data || typeof data !== 'object') return null;
  const queue = [data];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    for (const [key, value] of Object.entries(current)) {
      const lower = key.toLowerCase();
      if (keywords.some((k) => lower.includes(String(k).toLowerCase()))) {
        const mapped = mapDistributionObject(value);
        if (mapped) return mapped;
      }
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function mapDistributionObject(value) {
  if (!value || typeof value !== 'object') return null;
  const isElementMap = ['목','화','토','금','수'].every((k) => Object.keys(value).some((x) => x.includes(k)));
  if (isElementMap) {
    return {
      목: Number(findLooseValue(value, ['목']) || 0),
      화: Number(findLooseValue(value, ['화']) || 0),
      토: Number(findLooseValue(value, ['토']) || 0),
      금: Number(findLooseValue(value, ['금']) || 0),
      수: Number(findLooseValue(value, ['수']) || 0)
    };
  }
  const tenGodLabels = ['비견','겁재','식신','상관','편재','정재','편관','정관','편인','정인'];
  const matched = tenGodLabels.filter((k) => Object.keys(value).some((x) => x.includes(k)));
  if (matched.length >= 4) {
    return Object.fromEntries(tenGodLabels.map((k) => [k, Number(findLooseValue(value, [k]) || 0)]));
  }
  return null;
}

function findLooseValue(obj, keys) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (keys.some((key) => k.includes(key))) return v;
  }
  return null;
}

function findValueByKeys(root, keys) {
  if (!root || typeof root !== 'object') return null;
  const queue = [root];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    for (const [key, value] of Object.entries(current)) {
      if (keys.some((needle) => key.toLowerCase() === needle.toLowerCase())) return value;
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function defaultElementDistribution(payload) {
  const seed = Number(payload.birthMonth || 1) + Number(payload.birthDay || 1);
  return { 목: (seed % 23) + 18, 화: 15 + (seed % 11), 토: 18 + (seed % 9), 금: 17 + (seed % 7), 수: 16 + (seed % 13) };
}

function defaultTenGodDistribution(payload) {
  const seed = Number(payload.birthYear || 1990);
  return {
    비견: 12 + (seed % 8), 겁재: 8 + (seed % 5), 식신: 9 + (seed % 7), 상관: 7 + (seed % 6), 편재: 11 + (seed % 9),
    정재: 10 + (seed % 4), 편관: 9 + (seed % 8), 정관: 8 + (seed % 6), 편인: 13 + (seed % 7), 정인: 11 + (seed % 5)
  };
}

function buildAiPromptPayload(order, apiSnapshots, warnings) {
  const now = new Date();
  const baseline = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const mansaePillars = extractPillars(apiSnapshots.mansae || apiSnapshots.saju, order.applicant);
  const sajuPillars = extractPillars(apiSnapshots.saju || apiSnapshots.mansae, order.applicant);
  if ([mansaePillars.year, mansaePillars.month, mansaePillars.day, mansaePillars.hour].join('|') !== [sajuPillars.year, sajuPillars.month, sajuPillars.day, sajuPillars.hour].join('|')) {
    warnings.push('만세력 API와 사주 API의 간지 표기가 일부 다르게 보여 확인 메모를 함께 남깁니다.');
  }

  return {
    baselineDate: baseline,
    applicant: order.applicant,
    partner: order.partner,
    compatibilityRequested: order.compatibilityRequested,
    calculationMemo: warnings,
    rawSajuText: JSON.stringify(apiSnapshots.saju || {}, null, 2),
    mansaeInfo: apiSnapshots.mansae || null,
    futureFiveYears: apiSnapshots.period || null,
    futureSixMonths: apiSnapshots.period || null,
    compatibilityReference: apiSnapshots.compatibility || null,
    apiSnapshots,
    sectionsRequired: [
      '핵심 요약','사주 원국 해석','대운','세운','월운','운성','신살, 귀인','십성','재물운','직업운','애정운','자녀운','건강운','실천 조언','주의할 점','고민에 대한 조언'
    ].concat(apiSnapshots.compatibility ? ['궁합 참고 해석'] : [])
  };
}

async function generateAiSections(promptPayload) {
  if (!CONFIG.ai.apiKey) {
    if (CONFIG.allowLocalFallback) return fallbackAiSections(promptPayload);
    throw new Error('AI API 키가 설정되지 않았습니다.');
  }
  const schemaGuide = {
    '핵심 요약': 'string',
    '사주 원국 해석': 'string',
    '대운': 'string',
    '세운': 'string',
    '월운': 'string',
    '운성': 'string',
    '신살, 귀인': 'string',
    '십성': 'string',
    '재물운': 'string',
    '직업운': 'string',
    '애정운': 'string',
    '자녀운': 'string',
    '건강운': 'string',
    '실천 조언': 'string',
    '주의할 점': 'string',
    '고민에 대한 조언': 'string',
    '궁합 참고 해석': 'string (optional)'
  };
  const systemPrompt = [
    '당신은 한국어 전문 사주 리포트 작성자입니다.',
    '반드시 한국어로만 작성합니다.',
    '실제 상담자가 사람을 마주 보고 설명하듯 자연스럽게 작성합니다.',
    'API, 데이터, JSON, 시스템, 프롬프트, 모델, 알고리즘, 엔진 같은 기술 표현은 결과물에 절대 노출하지 않습니다.',
    '광고성 멘트나 면책문 없이 본문 중심으로 작성합니다.',
    '핵심 요약, 재물운, 직업운, 애정운, 건강운, 고민에 대한 조언은 특히 상세하게 작성합니다.',
    '대운은 1세부터 100세까지 흐름이 이어지도록 설명합니다.',
    '세운은 기준 시점 다음 해부터 5년을 해마다 나누어 설명합니다.',
    '월운은 기준 시점 다음 달부터 6개월을 한 달씩 나누어 설명합니다.',
    '실제 생활 예시를 포함하고, 조심할 부분도 부드럽지만 분명하게 설명합니다.',
    '아래 스키마 키를 그대로 사용하는 JSON 객체만 반환합니다.'
  ].join(' ');

  const userPrompt = {
    requiredOutputSchema: schemaGuide,
    input: promptPayload
  };

  const endpoint = `${CONFIG.ai.baseUrl}${CONFIG.ai.path}`;
  const style = CONFIG.ai.style || (endpoint.includes('/responses') ? 'responses' : 'chat_completions');
  const requestBody = style === 'responses'
    ? {
        model: CONFIG.ai.model,
        stream: false,
        reasoning: { effort: 'medium' },
        input: [
          { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
          { role: 'user', content: [{ type: 'input_text', text: JSON.stringify(userPrompt) }] }
        ]
      }
    : {
        model: CONFIG.ai.model,
        temperature: CONFIG.ai.temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: JSON.stringify(userPrompt) }
        ]
      };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CONFIG.ai.apiKey}`
    },
    body: JSON.stringify(requestBody)
  });
  const raw = await response.text();
  if (!response.ok) {
    if (CONFIG.allowLocalFallback) return fallbackAiSections(promptPayload);
    throw new Error(`AI 호출 실패: ${response.status}`);
  }
  const parsed = safeJsonParse(raw);
  const content = style === 'responses'
    ? extractResponsesText(parsed)
    : parsed?.choices?.[0]?.message?.content || parsed?.output_text || raw;
  try {
    const cleaned = typeof content === 'string' ? stripCodeFences(content) : content;
    return typeof cleaned === 'string' ? safeJsonParse(cleaned) : cleaned;
  } catch {
    if (CONFIG.allowLocalFallback) return fallbackAiSections(promptPayload);
    throw new Error('AI 응답을 JSON으로 해석하지 못했습니다.');
  }
}

function fallbackAiSections(promptPayload) {
  const name = promptPayload.applicant.name || '고객';
  const concern = promptPayload.applicant.concern || '현재 삶의 방향';
  const hasCompatibility = Boolean(promptPayload.compatibilityReference || hasPartnerCoreFields(promptPayload.partner));
  const sections = {
    '핵심 요약': `${name}님은 기본적으로 자기 기준이 분명하면서도 흐름을 읽는 감각이 좋은 편입니다. 한 번에 크게 방향을 바꾸기보다, 이미 쌓아온 기반 위에서 기회를 확장할 때 성과가 잘 나는 타입으로 보입니다. 지금 시점에서는 조급함보다 우선순위를 정리하는 힘이 중요합니다.`,
    '사주 원국 해석': `${name}님의 사주는 바깥으로 드러나는 추진력과 안쪽에서 오래 버티는 힘이 함께 읽히는 구조로 정리됩니다. 겉으로는 담담해 보여도 내면에서는 기준이 뚜렷하고, 사람이나 일에서 신뢰가 무너지면 빠르게 거리를 조정하는 경향이 있습니다. 중요한 결정은 감정만으로 움직이기보다 자신이 납득할 수 있는 이유를 확보한 뒤 실행하는 방식이 잘 맞습니다.`,
    '대운': `1세부터 20세 전후까지는 환경 적응과 기본기 형성에 무게가 실리는 흐름입니다. 20대 이후에는 자신의 선택이 결과를 크게 바꾸는 시기로 들어가며, 30~40대에는 일과 재정, 관계의 균형을 다시 설계하는 기회가 많아집니다. 50대 이후에는 이미 축적한 경험을 바탕으로 안정성과 영향력을 함께 키우는 흐름이 이어지고, 70대 이후에는 속도를 줄이되 삶의 만족도를 높이는 방향이 중요합니다.`,
    '세운': `기준 시점 다음 해부터 5년은 방향 재정비, 실속 강화, 인간관계 정리, 확장 기회, 장기 안정화의 순서로 읽는 것이 좋습니다. 첫해에는 준비와 정리가 핵심이고, 둘째 해에는 눈에 보이는 성과보다 구조를 다지는 것이 유리합니다. 셋째 해에는 관계의 폭이 넓어질 수 있으나 에너지 분산을 주의해야 합니다. 넷째 해에는 한 번 크게 시도해볼 만한 기회가 보이며, 다섯째 해에는 그 결과를 정착시키는 흐름이 중요합니다.`,
    '월운': `다음 6개월은 1개월차 정비, 2개월차 실행, 3개월차 점검, 4개월차 확장, 5개월차 조율, 6개월차 수확의 리듬으로 보는 것이 좋습니다. 특히 2~4개월차에는 대인관계와 실무에서 작은 선택이 크게 작용할 수 있으니 일정과 감정 소비를 함께 관리해 주세요.`,
    '운성': `운성의 흐름에서는 시작과 정착의 에너지가 번갈아 들어오는 모습으로 읽힙니다. 새로운 계기를 받아들이는 힘은 있으나, 그만큼 체력과 집중력 배분이 중요합니다. 시작은 빠르더라도 마무리는 한 템포 천천히 점검하는 방식이 더 안정적입니다.`,
    '신살, 귀인': `도움을 주는 귀인성은 관계 속에서 자연스럽게 작동하는 편입니다. 다만 모든 인연이 오래 가는 것은 아니므로, 당장 반가운 제안이라도 조건과 역할을 명확히 해야 손실을 줄일 수 있습니다. 조심해야 할 시기에는 말보다 기록과 확인 절차가 더 큰 보호가 됩니다.`,
    '십성': `십성 흐름에서는 스스로 판단하고 책임지려는 힘이 강하게 작동합니다. 장점은 독립성과 추진력이고, 단점은 혼자 너무 많이 짊어지는 순간 피로가 크게 쌓인다는 점입니다. 협업에서는 본인이 맡아야 할 부분과 넘겨야 할 부분을 분리할수록 결과가 좋아집니다.`,
    '재물운': `재물운은 한 번에 큰 변동을 노리기보다 구조적으로 새는 지출을 줄이고, 꾸준히 쌓이는 자산 루틴을 만드는 쪽이 더 잘 맞습니다. 돈의 흐름은 사람, 기회, 일의 리듬과 연결되어 움직이므로 단기 수익에만 매달리기보다 자신이 오래 유지할 수 있는 방식인지 먼저 점검해 주세요. 특히 계약, 공동 지출, 큰 소비에서는 기준을 명확히 세우는 것이 중요합니다.`,
    '직업운': `직업운은 실무 감각과 책임감이 강점으로 보입니다. 다만 단순 반복만 있는 구조에서는 쉽게 지치기 때문에, 역할의 성장 가능성이나 권한 범위가 있는 환경이 더 잘 맞습니다. 이직이나 역할 변경을 고민한다면 명함의 화려함보다 실제 업무 범위, 배울 수 있는 폭, 사람 구성을 먼저 보세요.`,
    '애정운': `애정운에서는 감정의 진정성과 생활의 안정감이 함께 맞아야 오래 갑니다. 상대에게 배려를 많이 하는 편이지만, 마음이 식는 계기도 분명해서 불편함이 쌓이면 갑자기 거리감이 생길 수 있습니다. 초반의 설렘보다 시간이 지나도 편안한지, 약속을 지키는지, 생활 리듬이 맞는지를 더 중요하게 보시는 것이 좋습니다.`,
    '자녀운': `자녀운은 책임감과 보호 본능이 함께 작동하는 흐름으로 읽힙니다. 직접 돌보는 역할에서는 애정이 깊지만 기준도 분명한 편이라, 지나친 통제보다 대화를 통해 방향을 함께 맞춰가는 방식이 더 좋습니다. 자녀 계획이나 양육 고민이 있다면 현실적인 일정과 체력 분배를 함께 고려해 주세요.`,
    '건강운': `건강운에서는 과로와 누적 피로 관리가 가장 중요합니다. 몸이 크게 무너지기 전에 신호를 보내는 타입일 가능성이 높아, 수면 패턴, 위장 컨디션, 어깨·목 긴장처럼 반복되는 부분을 초기에 다루는 것이 좋습니다. 컨디션이 떨어질 때는 무리해서 버티기보다 생활 리듬을 회복하는 것이 결과적으로 더 빠릅니다.`,
    '실천 조언': `지금 시기에는 해야 할 일을 늘리는 것보다, 이미 하고 있는 일 중에서 남길 것과 덜어낼 것을 정리하는 실천이 중요합니다. 한 달 단위 목표를 작게 쪼개고, 일정·돈·감정 사용량을 함께 기록해 보세요. 기록은 불안감을 줄이고 방향 감각을 되찾는 데 큰 도움이 됩니다.`,
    '주의할 점': `가장 주의할 점은 조급함 때문에 준비가 덜 된 상태에서 큰 결정을 밀어붙이는 것입니다. 사람을 믿는 것과 검증 없이 맡기는 것은 다르니, 중요한 계약이나 약속은 반드시 문서와 일정 기준으로 다시 확인하세요. 감정적으로 지친 상태에서 관계를 정리하면 후회가 남을 수 있으니 하루 정도 숨을 고른 뒤 판단하는 것이 좋습니다.`,
    '고민에 대한 조언': `${name}님이 적어주신 고민인 "${concern}"은 단순히 운의 좋고 나쁨보다, 지금 무엇을 먼저 정리하고 어디에 힘을 모을지와 더 깊이 연결되어 있습니다. 지금은 모든 문제를 한 번에 해결하려 하기보다, 가장 체감이 큰 한 가지를 먼저 명확히 정하고 그 다음 단계를 설계하는 방식이 맞습니다. 원하는 결과를 얻기 위해서는 타이밍도 중요하지만, 그 타이밍을 받아낼 준비를 갖추는 것이 더 중요합니다.`
  };
  if (hasCompatibility) {
    sections['궁합 참고 해석'] = `두 사람의 궁합은 단순한 좋고 나쁨보다 서로가 관계에서 어떤 안정감을 원하는지, 갈등이 생겼을 때 어떻게 회복하는지가 핵심입니다. 서로의 속도와 표현 방식이 다를 수 있으므로, 감정을 추측하기보다 말과 행동의 기준을 맞추는 과정이 중요합니다. 상대에 대한 기대가 커질수록 실망도 커질 수 있으니, 관계의 방향을 천천히 확인하면서 신뢰를 쌓아가세요.`;
  }
  return sections;
}

async function renderPremiumPdf(order, promptPayload, sections) {
  const dateStamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const safeName = sanitizeFileName(order.applicant.name || 'report');
  const filePath = path.join(REPORTS_DIR, `${safeName}-${dateStamp}.pdf`);

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: true });
    const stream = fsSync.createWriteStream(filePath);
    doc.pipe(stream);
    doc.registerFont('Regular', FONT_REGULAR);
    doc.registerFont('Bold', FONT_BOLD);

    const page = { width: 595.28, height: 841.89, margin: 50 };
    const colors = { text: '#352c29', muted: '#6f625b', primary: '#cf8f7a', line: '#eadfd2', soft: '#f8f3ee', card: '#fffdf9' };

    const ensureSpace = (needed = 80) => {
      if (doc.y + needed > page.height - page.margin) {
        doc.addPage();
        doc.font('Regular').fillColor(colors.text);
      }
    };

    const sectionTitle = (title) => {
      ensureSpace(60);
      doc.moveDown(0.6);
      doc.roundedRect(page.margin, doc.y, page.width - page.margin * 2, 28, 12).fillAndStroke('#fff5f0', '#f0ddd1');
      doc.fillColor(colors.primary).font('Bold').fontSize(14).text(title, page.margin + 14, doc.y + 8, { width: page.width - page.margin * 2 - 28 });
      doc.moveDown(1.8);
      doc.fillColor(colors.text).font('Regular');
    };

    const paragraph = (text) => {
      if (!text) return;
      const parts = String(text).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
      parts.forEach((part) => {
        ensureSpace(70);
        doc.font('Regular').fontSize(11.5).fillColor(colors.text).text(part, { lineGap: 6, paragraphGap: 10, align: 'left' });
        doc.moveDown(0.5);
      });
    };

    const infoRow = (label, value) => {
      ensureSpace(28);
      doc.font('Bold').fontSize(10.5).fillColor(colors.muted).text(label, page.margin + 14, doc.y, { continued: true });
      doc.font('Regular').fillColor(colors.text).text(`  ${value || '-'}`);
    };

    doc.rect(0, 0, page.width, page.height).fill('#fffdfa');
    doc.fillColor('#f6eee7').circle(page.width - 70, 90, 80).fill();
    doc.fillColor('#e7f1ed').circle(80, page.height - 100, 72).fill();
    doc.fillColor(colors.text).font('Bold').fontSize(28).text('프리미엄 사주 리포트', page.margin, 92);
    doc.moveDown(0.3);
    doc.font('Regular').fontSize(14).fillColor(colors.muted).text(`${order.applicant.name}님을 위한 맞춤 해설`, { width: 320, lineGap: 4 });
    doc.moveDown(1.1);
    doc.roundedRect(page.margin, 180, page.width - page.margin * 2, 108, 22).fillAndStroke('#fffaf6', '#eadfd2');
    doc.fillColor(colors.text).font('Bold').fontSize(14).text('기본 정보', page.margin + 18, 198);
    doc.font('Regular').fontSize(11).fillColor(colors.muted)
      .text(`생년월일: ${order.applicant.birthYear}.${pad2(order.applicant.birthMonth)}.${pad2(order.applicant.birthDay)}`, page.margin + 18, 226)
      .text(`달력 기준: ${order.applicant.calendarType === 'lunar' ? '음력' : '양력'} / 성별: ${order.applicant.gender === 'male' ? '남성' : '여성'}`, page.margin + 18, 244)
      .text(`출생 시각: ${order.applicant.birthTime || '미입력'} / 생성일: ${new Date().toLocaleDateString('ko-KR')}`, page.margin + 18, 262);

    if (order.applicant.concern) {
      doc.roundedRect(page.margin, 312, page.width - page.margin * 2, 90, 18).fillAndStroke('#f8f3ee', '#eadfd2');
      doc.font('Bold').fontSize(13).fillColor(colors.primary).text('현재 고민', page.margin + 18, 328);
      doc.font('Regular').fontSize(11).fillColor(colors.text).text(order.applicant.concern, page.margin + 18, 350, { width: page.width - page.margin * 2 - 36, lineGap: 5 });
      doc.y = 420;
    } else {
      doc.y = 330;
    }

    sectionTitle('기본 정보 요약');
    infoRow('상품', order.product.name);
    infoRow('연락처', order.applicant.phone || '-');
    infoRow('이메일', order.applicant.email || '-');
    if (order.partner?.name) infoRow('상대방', `${order.partner.name} / ${order.partner.gender === 'male' ? '남성' : '여성'}`);
    if ((promptPayload.calculationMemo || []).length) {
      sectionTitle('계산 확인 메모');
      paragraph((promptPayload.calculationMemo || []).map((item) => `• ${item}`).join('\n'));
    }

    const orderedSections = [
      '핵심 요약','사주 원국 해석','오행/십성 등 주요 분석 요약','대운','세운','월운','운성','신살, 귀인','십성','재물운','직업운','애정운','자녀운','건강운','실천 조언','주의할 점','고민에 대한 조언','궁합 참고 해석'
    ];

    const synthetic = {
      '오행/십성 등 주요 분석 요약': buildApiDigest(promptPayload.apiSnapshots)
    };

    for (const title of orderedSections) {
      const body = sections[title] || synthetic[title];
      if (!body) continue;
      sectionTitle(title);
      paragraph(body);
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return filePath;
}

function buildApiDigest(apiSnapshots) {
  const lines = [];
  const pillars = extractPillars(apiSnapshots.saju || apiSnapshots.mansae, { birthYear: 1990, birthMonth: 1, birthDay: 1, birthTime: '09:00' });
  lines.push(`사주 원문 기준 네 기둥은 ${pillars.year}년주, ${pillars.month}월주, ${pillars.day}일주, ${pillars.hour}시주 흐름으로 정리됩니다.`);
  if (apiSnapshots.period) lines.push('시기별 운세 자료를 함께 반영하여 향후 5년과 다음 6개월의 흐름을 입체적으로 연결했습니다.');
  if (apiSnapshots.compatibility) lines.push('궁합 참고 자료가 함께 들어와 관계 리듬과 상호 보완 포인트도 별도로 반영했습니다.');
  return lines.join('\n\n');
}

function extractResponsesText(parsed) {
  const output = Array.isArray(parsed?.output) ? parsed.output : [];
  for (const item of output) {
    if (item?.type === 'message' && Array.isArray(item.content)) {
      const textItem = item.content.find((part) => part?.type === 'output_text' && typeof part.text === 'string');
      if (textItem?.text) return textItem.text;
    }
  }
  return parsed?.output_text || JSON.stringify(parsed);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

function stripCodeFences(text) {
  return String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
}

function logLine(type, detail) {
  return { at: new Date().toISOString(), type, detail };
}

async function saveOrder(order) {
  order.updatedAt = new Date().toISOString();
  const filePath = path.join(ORDERS_DIR, `${order.id}.json`);
  await fs.writeFile(filePath, JSON.stringify(order, null, 2), 'utf8');
}

async function readOrder(orderId) {
  try {
    const filePath = path.join(ORDERS_DIR, `${orderId}.json`);
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function appendLog(name, payload) {
  const filePath = path.join(LOGS_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
  const line = `[${new Date().toISOString()}] ${name} ${JSON.stringify(payload)}\n`;
  await fs.appendFile(filePath, line, 'utf8');
}

async function ensureDirectories() {
  await Promise.all([ORDERS_DIR, REPORTS_DIR, LOGS_DIR, TMP_DIR].map((dir) => fs.mkdir(dir, { recursive: true })));
}

function sanitizeFileName(name) {
  return String(name || 'report').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function pad2(value) {
  return String(value || '').padStart(2, '0');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
