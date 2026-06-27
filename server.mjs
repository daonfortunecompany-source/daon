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
  const rawBody = req.body || {};
  let parsedBirthInput = null;
  let mansaeRequestPayload = null;
  try {
    console.log('[FREE SUMMARY] request received');
    const payload = normalizeApplicant(rawBody);
    const luckyPayload = toLuckyFlatPayload(payload);
    parsedBirthInput = {
      year: payload.birthYear,
      month: payload.birthMonth,
      day: payload.birthDay,
      hour: payload.birthTime ? String(payload.birthTime).split(':')[0] || '' : '',
      minute: payload.birthTime ? String(payload.birthTime).split(':')[1] || '' : '',
      calendar: payload.calendarType,
      calendarType: payload.calendarType,
      gender: payload.gender,
      isLeapMonth: payload.isLeapMonth === true,
      birthTimeUnknown: payload.birthTimeUnknown
    };
    mansaeRequestPayload = {
      year: luckyPayload.year,
      month: luckyPayload.month,
      day: luckyPayload.day,
      hour: luckyPayload.hour,
      minute: luckyPayload.minute,
      birthYear: luckyPayload.birthYear,
      birthMonth: luckyPayload.birthMonth,
      birthDay: luckyPayload.birthDay,
      birthHour: luckyPayload.birthHour,
      birthMinute: luckyPayload.birthMinute,
      calendarType: luckyPayload.calendarType,
      calendar: luckyPayload.calendar,
      gender: luckyPayload.gender,
      isLeapMonth: luckyPayload.isLeapMonth
    };
    console.log('[FREE SUMMARY] parsed birth input:', JSON.stringify(parsedBirthInput));
    console.log('[MANSAE API] request payload:', JSON.stringify(mansaeRequestPayload));
    let mansaeData = null;
    let sajuData = null;
    let source = 'lucky';
    let usingFallback = false;
    let selectedPillars = null;
    let selectedPillarDebug = null;
    try {
      mansaeData = await callLuckyApi(CONFIG.lucky.mansaeUrl, [luckyPayload], 'mansae');
      logLuckyResponseDiagnostics('mansae', mansaeData, payload);
      let pillarDebug = extractPillarsDetailed(mansaeData, payload, { allowFallback: false });
      console.log('[LUCKY API] selected birth pillars from mansae:', JSON.stringify({
        status: pillarDebug.status,
        pillars: pillarDebug.pillars,
        selectedPaths: pillarDebug.selectedPaths
      }));

      if (CONFIG.lucky.sajuUrl) {
        console.log('[FREE SUMMARY] verifying birth pillars with saju endpoint');
        try {
          sajuData = await callLuckyApi(CONFIG.lucky.sajuUrl, [luckyPayload], 'saju');
          logLuckyResponseDiagnostics('saju', sajuData, payload);
          const sajuPillarDebug = extractPillarsDetailed(sajuData, payload, { allowFallback: false });
          console.log('[LUCKY API] selected birth pillars from saju:', JSON.stringify({
            status: sajuPillarDebug.status,
            pillars: sajuPillarDebug.pillars,
            selectedPaths: sajuPillarDebug.selectedPaths
          }));
          if (isBetterBirthPillarSelection(sajuPillarDebug, pillarDebug)) {
            pillarDebug = sajuPillarDebug;
          }
        } catch (secondaryError) {
          await appendLog('summary_saju_api_warning', {
            error: secondaryError.message,
            parsedBirthInput,
            mansaeRequestPayload
          });
        }
      }
      validateBirthPillarSelection(pillarDebug, payload);
      selectedPillars = pillarDebug.pillars;
      selectedPillarDebug = pillarDebug;
    } catch (error) {
      await appendLog('summary_api_warning', {
        error: error.message,
        parsedBirthInput,
        mansaeRequestPayload
      });
      if (error.summaryMeta) {
        console.log('[LUCKY API] using fallback: false');
        throw error;
      }
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
    const analysisData = sajuData ? { mansae: mansaeData, saju: sajuData } : mansaeData;
    const result = buildFreeSummary(payload, analysisData, {
      source,
      usingFallback,
      selectedPillars,
      selectedPillarsFrom: pillarDebugToResponsePaths(selectedPillarDebug),
      inputEcho: {
        year: payload.birthYear,
        month: payload.birthMonth,
        day: payload.birthDay,
        hour: payload.birthTime ? String(payload.birthTime).split(':')[0] || '' : '',
        minute: payload.birthTime ? String(payload.birthTime).split(':')[1] || '' : '',
        calendar: payload.calendarType,
        gender: payload.gender,
        isLeapMonth: payload.isLeapMonth === true
      }
    });
    res.json({ result });
  } catch (error) {
    const rawMessage = error.message || '요약 결과를 생성하지 못했습니다.';
    console.error('[FREE SUMMARY] error:', rawMessage);
    await appendLog('free_summary_error', {
      error: rawMessage,
      requestBody: rawBody,
      parsedBirthInput,
      mansaeRequestPayload
    });
    const userMessage = /년,\s*월,\s*일을\s*모두\s*입력해주세요/.test(rawMessage) || /mansae api 400/i.test(rawMessage)
      ? '생년월일 정보가 정상 전달되지 않았습니다. 잠시 후 다시 시도해주세요.'
      : rawMessage;
    if (error.summaryMeta) {
      return res.status(400).json({
        ok: false,
        error: userMessage,
        source: error.summaryMeta.source || 'lucky',
        usingFallback: Boolean(error.summaryMeta.usingFallback),
        inputEcho: parsedBirthInput ? {
          year: parsedBirthInput.year,
          month: parsedBirthInput.month,
          day: parsedBirthInput.day,
          hour: parsedBirthInput.hour,
          minute: parsedBirthInput.minute,
          calendar: parsedBirthInput.calendar,
          gender: parsedBirthInput.gender,
          isLeapMonth: parsedBirthInput.isLeapMonth
        } : null,
        selectedPillarsFrom: error.summaryMeta.selectedPillarsFrom || { year: '', month: '', day: '', hour: '' }
      });
    }
    res.status(400).json({ error: userMessage });
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
      person1: input.person1,
      person2: input.person2,
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
    const hasPerson1 = Boolean(order.applicant?.name && order.applicant?.birthYear && order.applicant?.birthMonth && order.applicant?.birthDay);
    const hasPerson2 = Boolean(order.partner?.name && order.partner?.birthYear && order.partner?.birthMonth && order.partner?.birthDay && order.partner?.gender);
    console.log('[PDF] order data loaded:', JSON.stringify({
      orderId: order.id,
      productType: order.product?.type || 'single',
      compatibilityRequested: Boolean(order.compatibilityRequested),
      hasPerson1,
      hasPerson2
    }));

    const mansaeResult = await optionalApiCall('mansae', CONFIG.lucky.mansaeUrl, [applicantPayload], warnings, false);
    if (mansaeResult.data) apiSnapshots.mansae = mansaeResult.data;

    const sajuCandidates = [{ ...applicantPayload }];
    const sajuResult = await optionalApiCall('saju', CONFIG.lucky.sajuUrl, sajuCandidates, warnings, true);
    if (sajuResult.data) apiSnapshots.saju = sajuResult.data;

    const periodCandidates = buildPeriodPayloadCandidates(applicantPayload);
    const periodResult = await optionalApiCall('period', CONFIG.lucky.periodUrl, periodCandidates, warnings, true);
    if (periodResult.data) apiSnapshots.period = periodResult.data;

    if (shouldCallCompatibility(order)) {
      const compatibilityPayload = buildCompatibilityPayload(order.applicant, order.partner, order.partner?.memo || '');
      console.log('[COMPATIBILITY API] request payload check:', JSON.stringify({
        hasPerson1: Boolean(compatibilityPayload.person1),
        hasPerson2: Boolean(compatibilityPayload.person2),
        person1Keys: Object.keys(compatibilityPayload.person1 || {}),
        person2Keys: Object.keys(compatibilityPayload.person2 || {})
      }));
      const compatibilityResult = await optionalApiCall('compatibility', CONFIG.lucky.compatibilityUrl, [compatibilityPayload], warnings, true);
      if (compatibilityResult.data) apiSnapshots.compatibility = compatibilityResult.data;
    }

    if (!apiSnapshots.saju) {
      throw new Error('핵심 사주 데이터 호출에 실패했습니다.');
    }
    if (shouldCallCompatibility(order) && !apiSnapshots.compatibility) {
      throw new Error('궁합 데이터 호출에 실패했습니다.');
    }
    if (!apiSnapshots.period) {
      throw new Error('기간운 데이터 호출에 실패했습니다.');
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
    warnings.push(`${label} API 호출 실패`);
    await appendLog(critical ? 'critical_api_failure' : 'api_failure', { label, message: error.message });
    if (critical) throw error;
    return { data: null, error };
  }
}

async function callLuckyApi(url, payloadCandidates, label) {
  console.log('[LUCKY API] request start');
  const candidates = Array.isArray(payloadCandidates) ? payloadCandidates : [payloadCandidates];
  candidates.forEach((payload) => {
    console.log(`[LUCKY API] final request payload (${label}): ${JSON.stringify(sanitizeLuckyPayloadForLog(payload))}`);
  });
  if (!CONFIG.lucky.apiKey) {
    throw new Error('LUCKY_API_KEY가 설정되지 않았습니다.');
  }
  const authVariants = resolveLuckyAuthVariants();
  let lastError = new Error(`${label} API 호출 실패`);

  for (const payload of candidates) {
    for (const authVariant of authVariants) {
      try {
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json'
        };
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
            url: sanitizeLuckyUrlForLog(requestUrl),
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

function sanitizeLuckyPayloadForLog(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const cloned = JSON.parse(JSON.stringify(payload));
  return cloned;
}

function sanitizeLuckyUrlForLog(url) {
  try {
    const parsed = new URL(url);
    if (parsed.searchParams.has('apiKey')) parsed.searchParams.set('apiKey', '[redacted]');
    return parsed.toString();
  } catch {
    return String(url || '');
  }
}

function logLuckyResponseDiagnostics(label, data, fallbackPerson) {
  console.log(`[LUCKY API] response top-level keys (${label}): ${JSON.stringify(safeObjectKeys(data))}`);
  console.log(`[LUCKY API] response data keys (${label}): ${JSON.stringify(collectResponseDataKeys(data))}`);
  const pillarDebug = extractPillarsDetailed(data, fallbackPerson, { allowFallback: false });
  console.log(`[LUCKY API] candidate pillar fields (${label}): ${JSON.stringify(pillarDebug.candidates.slice(0, 12))}`);
  console.log(`[LUCKY API] selected pillar paths (${label}): ${JSON.stringify(pillarDebugToResponsePaths(pillarDebug))}`);
  console.log(`[LUCKY API] selected birth pillars (${label}): ${JSON.stringify(pillarDebug.pillars)}`);
}

function safeObjectKeys(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 30) : [];
}

function collectResponseDataKeys(value) {
  const buckets = [];
  if (!value || typeof value !== 'object') return buckets;
  for (const key of ['data', 'result', 'response', 'mansae', 'saju', 'payload']) {
    if (value[key] && typeof value[key] === 'object' && !Array.isArray(value[key])) {
      buckets.push({ key, keys: Object.keys(value[key]).slice(0, 30) });
    }
  }
  return buckets;
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
      return '결제 완료를 기다리고 있습니다.';
    case 'payment_success':
      return '사주를 해석하고 풀이하는 중입니다. 잠시만 기다려주세요.';
    case 'generating':
      return '사주를 해석하고 풀이하는 중입니다. 잠시만 기다려주세요.';
    case 'ready':
      return '프리미엄 리포트가 준비되었습니다. 아래 다운로드 버튼으로 결과물을 받으실 수 있습니다.';
    case 'payment_cancelled':
      return '결제가 취소되어 결과물 생성이 진행되지 않았습니다.';
    case 'failed':
      return '리포트 생성 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.';
    default:
      return '주문 상태를 확인하고 있습니다.';
  }
}

function normalizeOrderInput(input) {
  const applicantSource = input.applicant || input.person1 || {};
  const partnerSource = input.partner || input.person2 || null;
  const applicant = normalizeApplicant(applicantSource);
  const partner = partnerSource ? normalizeApplicant(partnerSource, true) : null;
  return {
    compatibilityRequested: Boolean(input.compatibilityRequested || input.productType === 'compatibility' || hasPartnerCoreFields(partner)),
    applicant,
    partner,
    person1: applicant,
    person2: partner
  };
}

function normalizeApplicant(raw, isPartner = false) {
  const dateParts = parseBirthDateParts(raw.birthDate || raw.date || '');
  const timeParts = parseBirthTimeParts(raw.birthTime || raw.time || '');
  const birthYear = normalizeYearValue(raw.birthYear || raw.year || dateParts.year || '');
  const birthMonth = normalizeMonthDayValue(raw.birthMonth || raw.month || dateParts.month || '');
  const birthDay = normalizeMonthDayValue(raw.birthDay || raw.day || dateParts.day || '');
  const birthTimeUnknown = raw.birthTimeUnknown === true || raw.birthTimeUnknown === 'true' || raw.birthTimeUnknown === 'unknown';
  const birthHour = normalizeHourMinuteValue(raw.birthHour || raw.hour || timeParts.hour || '', 23);
  const birthMinute = normalizeHourMinuteValue(raw.birthMinute || raw.minute || timeParts.minute || '', 59);
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
  const [hourRaw, minuteRaw] = String(person.birthTime || '').split(':');
  const year = normalizeYearValue(person.birthYear || '');
  const month = normalizeMonthDayValue(person.birthMonth || '');
  const day = normalizeMonthDayValue(person.birthDay || '');
  const hour = normalizeHourMinuteValue(hourRaw || '', 23);
  const minute = normalizeHourMinuteValue(minuteRaw || '', 59);
  const calendar = person.calendarType === 'lunar' ? 'lunar' : 'solar';
  const calendarLabel = formatCalendarTypeForLucky(calendar);
  return {
    name: String(person.name || '').trim(),
    year,
    month,
    day,
    hour,
    minute,
    birthYear: year,
    birthMonth: month,
    birthDay: day,
    birthHour: hour,
    birthMinute: minute,
    calendarType: calendarLabel,
    calendar,
    calendarLabel,
    gender: person.gender,
    isLeapMonth: person.isLeapMonth === true,
    leapMonth: person.isLeapMonth === true,
    useYajasiRule: true
  };
}

function normalizeCalendarType(value) {
  return value === 'lunar' || value === '음력' ? 'lunar' : 'solar';
}

function formatCalendarTypeForLucky(value) {
  return value === 'lunar' || value === '음력' ? '음력' : '양력';
}

function buildPeriodPayloadCandidates(applicantPayload) {
  const targetYear = CONFIG.lucky.defaultPeriodYear;
  const targetMonth = CONFIG.lucky.defaultPeriodMonth;
  const targetDay = CONFIG.lucky.defaultPeriodDay;
  const targetDate = `${String(targetYear).padStart(4, '0')}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
  return [
    {
      ...applicantPayload,
      targetYear,
      targetMonth,
      targetDate,
      targetYears: [targetYear],
      targetMonths: [targetMonth],
      targetDates: [targetDate]
    }
  ];
}

function buildCompatibilityPayload(person1, person2, note = '') {
  const a = toLuckyFlatPayload(person1 || {});
  const b = toLuckyFlatPayload(person2 || {});
  return {
    person1: {
      name: String(person1?.name || '').trim(),
      gender: a.gender,
      year: a.year,
      month: String(Number(a.month || 0) || '').trim() || a.month,
      day: String(Number(a.day || 0) || '').trim() || a.day,
      hour: a.hour,
      minute: a.minute || '00',
      calendarType: a.calendarType,
      isLeapMonth: a.isLeapMonth === true
    },
    person2: {
      name: String(person2?.name || '').trim(),
      gender: b.gender,
      year: b.year,
      month: String(Number(b.month || 0) || '').trim() || b.month,
      day: String(Number(b.day || 0) || '').trim() || b.day,
      hour: b.hour,
      minute: b.minute || '00',
      calendarType: b.calendarType,
      isLeapMonth: b.isLeapMonth === true
    },
    note: String(note || '').trim()
  };
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

function parseBirthDateParts(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (!match) return { year: '', month: '', day: '' };
  return {
    year: match[1],
    month: match[2],
    day: match[3]
  };
}

function parseBirthTimeParts(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: '', minute: '' };
  return {
    hour: match[1],
    minute: match[2]
  };
}

function normalizeYearValue(value) {
  return cleanDigits(value).slice(0, 4);
}

function normalizeMonthDayValue(value) {
  const digits = cleanDigits(value).slice(0, 2);
  if (!digits) return '';
  const number = Number(digits);
  if (!Number.isFinite(number) || number <= 0) return '';
  return String(number).padStart(2, '0');
}

function normalizeHourMinuteValue(value, max) {
  const digits = cleanDigits(value).slice(0, 2);
  if (digits === '') return '';
  const number = Number(digits);
  if (!Number.isFinite(number) || number < 0 || number > max) return '';
  return String(number).padStart(2, '0');
}

function cleanDigits(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function buildFreeSummary(payload, mansaeData, meta = {}) {
  const pillars = meta.selectedPillars || extractPillars(mansaeData, payload);
  const elements = extractDistribution(mansaeData, ['오행', 'five', 'element']) || defaultElementDistribution(payload);
  const tenGods = extractDistribution(mansaeData, ['십성', 'tenGod', 'ten']) || defaultTenGodDistribution(payload);
  const name = payload.name || '사용자';
  const dominantElement = Object.entries(elements).sort((a, b) => b[1] - a[1])[0]?.[0] || '목';
  const dominantGod = Object.entries(tenGods).sort((a, b) => b[1] - a[1])[0]?.[0] || '비견';
  const source = meta.source || (mansaeData ? 'lucky' : 'local');
  return {
    source,
    usingFallback: Boolean(meta.usingFallback),
    inputEcho: meta.inputEcho || {
      year: payload.birthYear,
      month: payload.birthMonth,
      day: payload.birthDay,
      hour: payload.birthTime ? String(payload.birthTime).split(':')[0] || '' : '',
      minute: payload.birthTime ? String(payload.birthTime).split(':')[1] || '' : '',
      calendar: payload.calendarType,
      gender: payload.gender,
      isLeapMonth: payload.isLeapMonth === true
    },
    selectedPillarsFrom: meta.selectedPillarsFrom || {
      year: '',
      month: '',
      day: '',
      hour: ''
    },
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
  const dayStem = String(pillars?.day || '')[0] || '';
  const make = (pillar, pillarKey) => {
    const p = String(pillar || '--');
    const gan = p[0] || '-';
    const ji = p[1] || '-';
    const apiSipseong = extractPillarSipseong(rawData, pillarKey);
    const localSipseong = computeLocalPillarSipseong(dayStem, p);
    const ganSipseong = apiSipseong.gan && apiSipseong.gan !== '-' ? apiSipseong.gan : localSipseong.gan;
    const jiSipseong = apiSipseong.ji && apiSipseong.ji !== '-' ? apiSipseong.ji : localSipseong.ji;
    if ((!apiSipseong.gan || apiSipseong.gan === '-') && ganSipseong) {
      console.log(`[SAJU WARNING] missing sipseong mapping pillar=${pillarKey} field=gan reason=Lucky response field not found, using local calculation`);
    }
    if ((!apiSipseong.ji || apiSipseong.ji === '-') && jiSipseong) {
      console.log(`[SAJU WARNING] missing sipseong mapping pillar=${pillarKey} field=ji reason=Lucky response field not found, using local calculation`);
    }
    return {
      hangul: p,
      hanja: `${maps.stemHanja[gan] || ''}${maps.branchHanja[ji] || ''}` || '-',
      gan,
      ji,
      eumyang: { gan: maps.yinYangStem[gan] || '-', ji: maps.yinYangBranch[ji] || '-' },
      ohaeng: { gan: maps.ohaengStem[gan] || '-', ji: maps.ohaengBranch[ji] || '-' },
      sipseong: { gan: ganSipseong || '', ji: jiSipseong || '' }
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

function computeLocalPillarSipseong(dayStem, pillar) {
  const gan = normalizeStemChar(String(pillar || '').slice(0, 1));
  const ji = normalizeBranchChar(String(pillar || '').slice(1, 2));
  return {
    gan: calculateTenGod(dayStem, gan),
    ji: calculateTenGod(dayStem, getMainHiddenStemForBranch(ji))
  };
}

function getMainHiddenStemForBranch(branch) {
  const map = {
    자: '계', 축: '기', 인: '갑', 묘: '을', 진: '무', 사: '병',
    오: '정', 미: '기', 신: '경', 유: '신', 술: '무', 해: '임'
  };
  return map[branch] || '';
}

function calculateTenGod(dayStemRaw, targetStemRaw) {
  const dayStem = normalizeStemChar(dayStemRaw);
  const targetStem = normalizeStemChar(targetStemRaw);
  if (!dayStem || !targetStem) return '';
  const stemOrder = ['갑','을','병','정','무','기','경','신','임','계'];
  const elementMap = { 갑: '목', 을: '목', 병: '화', 정: '화', 무: '토', 기: '토', 경: '금', 신: '금', 임: '수', 계: '수' };
  const polarityMap = { 갑: '양', 을: '음', 병: '양', 정: '음', 무: '양', 기: '음', 경: '양', 신: '음', 임: '양', 계: '음' };
  const generates = { 목: '화', 화: '토', 토: '금', 금: '수', 수: '목' };
  const controls = { 목: '토', 토: '수', 수: '화', 화: '금', 금: '목' };
  const dayElement = elementMap[dayStem];
  const targetElement = elementMap[targetStem];
  const samePolarity = polarityMap[dayStem] === polarityMap[targetStem];
  if (dayElement === targetElement) return samePolarity ? '비견' : '겁재';
  if (generates[dayElement] === targetElement) return samePolarity ? '식신' : '상관';
  if (controls[dayElement] === targetElement) return samePolarity ? '편재' : '정재';
  if (controls[targetElement] === dayElement) return samePolarity ? '편관' : '정관';
  if (generates[targetElement] === dayElement) return samePolarity ? '편인' : '정인';
  const dayIndex = stemOrder.indexOf(dayStem);
  const targetIndex = stemOrder.indexOf(targetStem);
  if (dayIndex === targetIndex) return '비견';
  return '';
}

function extractPillars(data, fallbackPerson) {
  const debug = extractPillarsDetailed(data, fallbackPerson);
  return debug.pillars;
}

function pillarDebugToResponsePaths(pillarDebug) {
  if (!pillarDebug) return { year: '', month: '', day: '', hour: '' };
  return {
    year: pillarDebug.selectedPaths?.year || '',
    month: pillarDebug.selectedPaths?.month || '',
    day: pillarDebug.selectedPaths?.day || '',
    hour: pillarDebug.selectedPaths?.hour || ''
  };
}

function isBetterBirthPillarSelection(nextDebug, currentDebug) {
  const nextCount = countSelectedBirthPillars(nextDebug);
  const currentCount = countSelectedBirthPillars(currentDebug);
  if (nextCount !== currentCount) return nextCount > currentCount;
  return sumSelectedCandidateScores(nextDebug) > sumSelectedCandidateScores(currentDebug);
}

function countSelectedBirthPillars(pillarDebug) {
  return ['year', 'month', 'day', 'hour'].filter((key) => Boolean(pillarDebug?.pillars?.[key])).length;
}

function sumSelectedCandidateScores(pillarDebug) {
  return Object.values(pillarDebug?.selectedScores || {}).reduce((sum, value) => sum + Number(value || 0), 0);
}

function validateBirthPillarSelection(pillarDebug, payload) {
  const missing = ['year', 'month', 'day', 'hour'].filter((key) => !pillarDebug?.pillars?.[key]);
  if (missing.length) {
    console.log(`[SAJU VALIDATION] missing birth pillars detected: ${missing.join(', ')}`);
    throw createStructuredSummaryError(`Lucky API에서 출생 ${missing.map(localizePillarName).join('/')} 필드를 찾지 못했습니다.`, {
      source: 'lucky',
      usingFallback: false,
      selectedPillarsFrom: pillarDebugToResponsePaths(pillarDebug)
    });
  }
  const expectedYearPillar = computeExpectedYearPillar(payload);
  if (expectedYearPillar && pillarDebug?.pillars?.year && pillarDebug.pillars.year !== expectedYearPillar) {
    console.log('[SAJU VALIDATION] year pillar mismatch');
    console.log(`[SAJU VALIDATION] expected: ${expectedYearPillar}`);
    console.log(`[SAJU VALIDATION] actual: ${pillarDebug.pillars.year}`);
    console.log(`[SAJU VALIDATION] input: ${payload.birthYear}-${payload.birthMonth}-${payload.birthDay} ${payload.birthTime || ''} ${payload.calendarType || payload.calendar || ''}`);
    throw createStructuredSummaryError(`생년주 검증에 실패했습니다. expected=${expectedYearPillar}, actual=${pillarDebug.pillars.year}`, {
      source: 'lucky',
      usingFallback: false,
      selectedPillarsFrom: pillarDebugToResponsePaths(pillarDebug)
    });
  }
  const repeatedCore = [pillarDebug.pillars.year, pillarDebug.pillars.month, pillarDebug.pillars.day];
  if (new Set(repeatedCore).size === 1) {
    console.log('[SAJU VALIDATION] suspicious repeated pillars detected');
    console.log(`[SAJU VALIDATION] year/month/day are identical: ${repeatedCore.join('/')}`);
    console.log('[SAJU VALIDATION] do not use repeated fallback as valid result');
    throw createStructuredSummaryError('Lucky API 응답에서 출생 월주/일주 필드를 신뢰할 수 없습니다. 원국 매핑을 다시 확인해 주세요.', {
      source: 'lucky',
      usingFallback: false,
      selectedPillarsFrom: pillarDebugToResponsePaths(pillarDebug)
    });
  }
  const hourBranch = normalizeBranchChar((pillarDebug.pillars.hour || '').slice(1));
  const expectedHourBranch = guessExpectedHourBranch(payload.birthTime || '');
  if (hourBranch && expectedHourBranch && hourBranch !== expectedHourBranch) {
    console.log(`[SAJU VALIDATION] hour branch mismatch detected: input=${payload.birthTime || ''}, expected=${expectedHourBranch}, actual=${hourBranch}`);
  }
}

function createStructuredSummaryError(message, meta = {}) {
  const error = new Error(message);
  error.summaryMeta = meta;
  return error;
}

function localizePillarName(key) {
  return ({ year: '생년주', month: '생월주', day: '생일주', hour: '생시주' })[key] || key;
}

function computeExpectedYearPillar(payload) {
  const year = Number(payload?.birthYear || payload?.year || 0);
  const month = Number(payload?.birthMonth || payload?.month || 0);
  const day = Number(payload?.birthDay || payload?.day || 0);
  const calendar = payload?.calendarType || payload?.calendar || 'solar';
  if (!Number.isFinite(year) || !month || !day || calendar !== 'solar') return '';
  const effectiveYear = (month > 2 || (month === 2 && day >= 4)) ? year : year - 1;
  const stems = ['갑','을','병','정','무','기','경','신','임','계'];
  const branches = ['자','축','인','묘','진','사','오','미','신','유','술','해'];
  const offset = effectiveYear - 1984;
  const stem = stems[((offset % 10) + 10) % 10];
  const branch = branches[((offset % 12) + 12) % 12];
  return `${stem}${branch}`;
}

function guessExpectedHourBranch(timeText) {
  const hour = Number(String(timeText || '').split(':')[0]);
  if (!Number.isFinite(hour)) return '';
  if (hour >= 23 || hour < 1) return '자';
  if (hour < 3) return '축';
  if (hour < 5) return '인';
  if (hour < 7) return '묘';
  if (hour < 9) return '진';
  if (hour < 11) return '사';
  if (hour < 13) return '오';
  if (hour < 15) return '미';
  if (hour < 17) return '신';
  if (hour < 19) return '유';
  if (hour < 21) return '술';
  return '해';
}

function extractPillarsDetailed(data, fallbackPerson = {}, options = {}) {
  const allowFallback = options.allowFallback !== false;
  const fallback = {
    year: generatePillarSeed(fallbackPerson.birthYear, 0),
    month: generatePillarSeed(fallbackPerson.birthMonth, 1),
    day: generatePillarSeed(fallbackPerson.birthDay, 2),
    hour: generatePillarSeed((fallbackPerson.birthTime || '09:00').split(':')[0], 3)
  };
  const expectedYearPillar = computeExpectedYearPillar(fallbackPerson);
  const expectedHourBranch = guessExpectedHourBranch(fallbackPerson.birthTime || '');
  const candidates = collectPillarCandidates(data);
  const selected = {};
  const selectedPaths = {};
  const selectedScores = {};
  for (const pillarType of ['year', 'month', 'day', 'hour']) {
    const bucket = candidates
      .filter((item) => item.type === pillarType && normalizePillar(item.value))
      .map((item) => ({
        ...item,
        weightedScore: item.score
          + (pillarType === 'year' && expectedYearPillar && normalizePillar(item.value) === expectedYearPillar ? 500 : 0)
          + (pillarType === 'hour' && expectedHourBranch && normalizeBranchChar(String(normalizePillar(item.value)).slice(1, 2)) === expectedHourBranch ? 120 : 0)
      }))
      .sort((a, b) => b.weightedScore - a.weightedScore);
    if (bucket[0]) {
      selected[pillarType] = normalizePillar(bucket[0].value);
      selectedPaths[pillarType] = bucket[0].path;
      selectedScores[pillarType] = bucket[0].weightedScore;
    }
  }
  const missing = ['year', 'month', 'day', 'hour'].filter((key) => !selected[key]);
  const usedFallback = missing.length > 0;
  const repeatedCore = [selected.year, selected.month, selected.day].filter(Boolean);
  const suspiciousRepeated = repeatedCore.length === 3 && new Set(repeatedCore).size === 1;
  return {
    pillars: {
      year: selected.year || (allowFallback ? fallback.year : ''),
      month: selected.month || (allowFallback ? fallback.month : ''),
      day: selected.day || (allowFallback ? fallback.day : ''),
      hour: selected.hour || (allowFallback ? fallback.hour : '')
    },
    status: missing.length ? 'missing' : suspiciousRepeated ? 'suspicious' : 'resolved',
    missing,
    suspiciousRepeated,
    usedFallback,
    selectedPaths,
    selectedScores,
    candidates: candidates.map(({ type, path, value, score, reason }) => ({ type, path, value: normalizePillar(value) || String(value || '').slice(0, 32), score, reason }))
  };
}

function collectPillarCandidates(root) {
  if (!root || typeof root !== 'object') return [];
  const candidates = [];
  const queue = [{ node: root, path: 'root', depth: 0 }];
  while (queue.length) {
    const { node, path, depth } = queue.shift();
    if (!node || typeof node !== 'object' || depth > 8) continue;
    if (pathHasExcludedToken(path)) continue;

    const structured = extractStructuredPillarCandidates(node, path);
    structured.forEach((item) => candidates.push(item));

    const entries = Array.isArray(node)
      ? node.map((value, index) => [String(index), value])
      : Object.entries(node);

    for (const [key, value] of entries) {
      const childPath = `${path}.${key}`;
      const guessedType = guessPillarType(childPath);
      const directPillar = normalizePillar(value);
      if (guessedType && directPillar) {
        candidates.push({
          type: guessedType,
          path: childPath,
          value: directPillar,
          score: scoreCandidatePath(childPath, 'direct'),
          reason: 'direct-value'
        });
      }
      if (value && typeof value === 'object') {
        queue.push({ node: value, path: childPath, depth: depth + 1 });
      }
    }
  }
  return dedupePillarCandidates(candidates);
}

function extractStructuredPillarCandidates(node, path) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const results = [];
  for (const pillarType of ['year', 'month', 'day', 'hour']) {
    const directValue = findDirectPillarValue(node, pillarType);
    if (directValue) {
      results.push({ type: pillarType, path: `${path}.${directValue.key}`, value: directValue.value, score: scoreCandidatePath(`${path}.${directValue.key}`, 'exact'), reason: 'direct-key' });
    }
    const combinedCurrent = combinePillarFromNode(node, pillarType, path);
    if (combinedCurrent) {
      results.push({ type: pillarType, path, value: combinedCurrent, score: scoreCandidatePath(path, 'combined-current'), reason: 'combined-current' });
    }
    const nestedNode = findNestedPillarNode(node, pillarType);
    if (nestedNode) {
      const combinedNested = combinePillarFromNode(nestedNode.value, pillarType, `${path}.${nestedNode.key}`) || normalizePillar(nestedNode.value);
      if (combinedNested) {
        results.push({ type: pillarType, path: `${path}.${nestedNode.key}`, value: combinedNested, score: scoreCandidatePath(`${path}.${nestedNode.key}`, 'nested'), reason: 'combined-nested' });
      }
    }
  }
  return results;
}

function findDirectPillarValue(node, pillarType) {
  for (const [key, value] of Object.entries(node || {})) {
    const lower = String(key).toLowerCase();
    if (!matchesPillarAlias(lower, pillarType)) continue;
    const normalized = normalizePillar(value);
    if (normalized) return { key, value: normalized };
  }
  return null;
}

function findNestedPillarNode(node, pillarType) {
  for (const [key, value] of Object.entries(node || {})) {
    if (!value || typeof value !== 'object') continue;
    const lower = String(key).toLowerCase();
    if (matchesPillarAlias(lower, pillarType) || containsAnyToken(lower, ['ganji', 'pillar', 'pillars', '사주', '원국', '만세력'])) {
      return { key, value };
    }
  }
  return null;
}

function combinePillarFromNode(node, pillarType, contextPath = '') {
  if (!node || typeof node !== 'object') return '';
  const hasTypeContext = matchesPillarAlias(contextPath, pillarType) || Object.keys(node).some((key) => matchesPillarAlias(key, pillarType));
  if (!hasTypeContext) return '';
  const stemValue = findValueByTokens(node, pillarType, ['stem', 'gan', 'heavenly', '천간']);
  const branchValue = findValueByTokens(node, pillarType, ['branch', 'ji', 'earthly', '지지']);
  if (!stemValue || !branchValue) return '';
  return combineNormalizedGanji(stemValue, branchValue);
}

function findValueByTokens(node, pillarType, kindTokens) {
  for (const [key, value] of Object.entries(node || {})) {
    const lower = String(key).toLowerCase();
    const matchesKind = kindTokens.some((token) => lower.includes(String(token).toLowerCase()));
    const matchesType = matchesPillarAlias(lower, pillarType) || !['year', 'month', 'day', 'hour'].some((other) => other !== pillarType && matchesPillarAlias(lower, other));
    if (matchesKind && matchesType) return value;
  }
  return '';
}

function dedupePillarCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.type}|${candidate.path}|${normalizePillar(candidate.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => b.score - a.score);
}

function guessPillarType(path) {
  const lower = String(path || '').toLowerCase();
  if (matchesPillarAlias(lower, 'year')) return 'year';
  if (matchesPillarAlias(lower, 'month')) return 'month';
  if (matchesPillarAlias(lower, 'day')) return 'day';
  if (matchesPillarAlias(lower, 'hour')) return 'hour';
  return '';
}

function matchesPillarAlias(text, pillarType) {
  const aliases = {
    year: ['yearpillar', 'yearganji', 'year', 'birthyearpillar', 'birthyearganji', 'birthyear', '년주', '생년주', '년간지'],
    month: ['monthpillar', 'monthganji', 'month', 'birthmonthpillar', 'birthmonthganji', 'birthmonth', '월주', '생월주', '월간지'],
    day: ['daypillar', 'dayganji', 'day', 'birthdaypillar', 'birthdayganji', 'birthday', '일주', '생일주', '일간지'],
    hour: ['hourpillar', 'timepillar', 'hourganji', 'timeganji', 'hour', 'time', 'birthhourpillar', 'birthhourganji', 'birthhour', '시주', '생시주', '시간지']
  };
  return aliases[pillarType].some((token) => String(text || '').toLowerCase().includes(String(token).toLowerCase()));
}

function pathHasExcludedToken(path) {
  return containsAnyToken(path, ['daeun', 'seun', 'period', 'fortune', 'future', 'default', 'baseyear', 'basemonth', 'baseday', 'today', 'daily', 'current', '월운', '세운', '대운', '일진', '시운', '기간', '운세']);
}

function scoreCandidatePath(path, mode) {
  let score = 40;
  const lower = String(path || '').toLowerCase();
  if (containsAnyToken(lower, ['ganji', 'pillar', 'pillars', 'birth', '사주', '원국', '만세력'])) score += 35;
  if (mode === 'exact') score += 50;
  if (mode === 'nested') score += 30;
  if (mode === 'combined-current') score += 25;
  if (containsAnyToken(lower, ['birthyear', 'birthmonth', 'birthday', 'birthhour', '생년', '생월', '생일', '생시'])) score += 25;
  if (pathHasExcludedToken(lower)) score -= 150;
  return score;
}

function containsAnyToken(text, tokens) {
  const lower = String(text || '').toLowerCase();
  return tokens.some((token) => lower.includes(String(token).toLowerCase()));
}

function combineNormalizedGanji(stemValue, branchValue) {
  const stem = normalizeStemChar(stemValue);
  const branch = normalizeBranchChar(branchValue);
  return stem && branch ? `${stem}${branch}` : '';
}

function normalizePillar(value) {
  const text = String(value || '').trim();
  const hangulMatch = text.match(/[갑을병정무기경신임계][자축인묘진사오미신유술해]/);
  if (hangulMatch) return hangulMatch[0];
  const hanjaMatch = text.match(/[甲乙丙丁戊己庚辛壬癸][子丑寅卯辰巳午未申酉戌亥]/);
  if (hanjaMatch) {
    return `${normalizeStemChar(hanjaMatch[0][0])}${normalizeBranchChar(hanjaMatch[0][1])}`;
  }
  if (text.length >= 2) {
    const combined = combineNormalizedGanji(text[0], text[1]);
    if (combined) return combined;
  }
  return '';
}

function normalizeStemChar(value) {
  const map = { 갑: '갑', 을: '을', 병: '병', 정: '정', 무: '무', 기: '기', 경: '경', 신: '신', 임: '임', 계: '계', 甲: '갑', 乙: '을', 丙: '병', 丁: '정', 戊: '무', 己: '기', 庚: '경', 辛: '신', 壬: '임', 癸: '계' };
  const chars = String(value || '').trim();
  for (const char of chars) {
    if (map[char]) return map[char];
  }
  return '';
}

function normalizeBranchChar(value) {
  const map = { 자: '자', 축: '축', 인: '인', 묘: '묘', 진: '진', 사: '사', 오: '오', 미: '미', 신: '신', 유: '유', 술: '술', 해: '해', 子: '자', 丑: '축', 寅: '인', 卯: '묘', 辰: '진', 巳: '사', 午: '오', 未: '미', 申: '신', 酉: '유', 戌: '술', 亥: '해' };
  const chars = String(value || '').trim();
  for (const char of chars) {
    if (map[char]) return map[char];
  }
  return '';
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
  const premiumSections = buildPremiumPdfSections(order, promptPayload, sections || {});

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
      const top = doc.y;
      doc.roundedRect(page.margin, top, page.width - page.margin * 2, 28, 12).fillAndStroke('#fff5f0', '#f0ddd1');
      doc.fillColor(colors.primary).font('Bold').fontSize(14).text(title, page.margin + 14, top + 8, { width: page.width - page.margin * 2 - 28 });
      doc.y = top + 34;
      doc.fillColor(colors.text).font('Regular');
    };

    const paragraph = (text) => {
      if (!text) return;
      const safeText = sanitizeCustomerFacingText(text);
      const parts = String(safeText).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
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

    const drawPillarTable = (pillarDetails) => {
      ensureSpace(250);
      const cols = [
        { key: 'head', title: '구분', width: 76 },
        { key: 'year', title: '년주', width: 104 },
        { key: 'month', title: '월주', width: 104 },
        { key: 'day', title: '일주', width: 104 },
        { key: 'hour', title: '시주', width: 104 }
      ];
      const left = page.margin;
      const top = doc.y;
      const rowHeight = 34;
      const widths = cols.map((col) => col.width);
      const rows = [
        ['천간', pillarDetails.year?.gan || '-', pillarDetails.month?.gan || '-', pillarDetails.day?.gan || '-', pillarDetails.hour?.gan || '-'],
        ['지지', pillarDetails.year?.ji || '-', pillarDetails.month?.ji || '-', pillarDetails.day?.ji || '-', pillarDetails.hour?.ji || '-'],
        ['천간 십성', pillarDetails.year?.sipseong?.gan || '', pillarDetails.month?.sipseong?.gan || '', pillarDetails.day?.sipseong?.gan || '', pillarDetails.hour?.sipseong?.gan || ''],
        ['지지 십성', pillarDetails.year?.sipseong?.ji || '', pillarDetails.month?.sipseong?.ji || '', pillarDetails.day?.sipseong?.ji || '', pillarDetails.hour?.sipseong?.ji || ''],
        ['오행', `${pillarDetails.year?.ohaeng?.gan || '-'} / ${pillarDetails.year?.ohaeng?.ji || '-'}`, `${pillarDetails.month?.ohaeng?.gan || '-'} / ${pillarDetails.month?.ohaeng?.ji || '-'}`, `${pillarDetails.day?.ohaeng?.gan || '-'} / ${pillarDetails.day?.ohaeng?.ji || '-'}`, `${pillarDetails.hour?.ohaeng?.gan || '-'} / ${pillarDetails.hour?.ohaeng?.ji || '-'}`],
        ['음양', `${pillarDetails.year?.eumyang?.gan || '-'} / ${pillarDetails.year?.eumyang?.ji || '-'}`, `${pillarDetails.month?.eumyang?.gan || '-'} / ${pillarDetails.month?.eumyang?.ji || '-'}`, `${pillarDetails.day?.eumyang?.gan || '-'} / ${pillarDetails.day?.eumyang?.ji || '-'}`, `${pillarDetails.hour?.eumyang?.gan || '-'} / ${pillarDetails.hour?.eumyang?.ji || '-'}`]
      ];

      let x = left;
      cols.forEach((col) => {
        doc.rect(x, top, col.width, rowHeight).fillAndStroke('#fbf6f0', '#e7ddd2');
        doc.fillColor('#6f5b50').font('Bold').fontSize(10.5).text(col.title, x, top + 11, { width: col.width, align: 'center' });
        x += col.width;
      });

      rows.forEach((row, rowIndex) => {
        let cellX = left;
        const y = top + rowHeight * (rowIndex + 1);
        row.forEach((cell, colIndex) => {
          doc.rect(cellX, y, widths[colIndex], rowHeight).fillAndStroke(colIndex === 0 ? '#f9f4ee' : '#ffffff', '#e7ddd2');
          doc.fillColor(colIndex === 0 ? '#856d5f' : colors.text)
            .font(colIndex === 0 ? 'Bold' : 'Regular')
            .fontSize(colIndex === 0 ? 10 : 10.5)
            .text(String(cell || '-'), cellX + 6, y + 9, { width: widths[colIndex] - 12, align: 'center' });
          cellX += widths[colIndex];
        });
      });
      doc.y = top + rowHeight * (rows.length + 1) + 16;
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
      doc.font('Regular').fontSize(11).fillColor(colors.text).text(sanitizeCustomerFacingText(order.applicant.concern), page.margin + 18, 350, { width: page.width - page.margin * 2 - 36, lineGap: 5 });
      doc.y = 420;
    } else {
      doc.y = 330;
    }

    sectionTitle('기본 정보');
    infoRow('상품', order.product.name);
    infoRow('연락처', order.applicant.phone || '-');
    infoRow('이메일', order.applicant.email || '-');
    if (order.partner?.name) {
      infoRow('상대방', `${order.partner.name} / ${order.partner.gender === 'male' ? '남성' : '여성'}`);
      infoRow('상대방 생년월일', `${order.partner.birthYear}.${pad2(order.partner.birthMonth)}.${pad2(order.partner.birthDay)} ${order.partner.birthTime || ''}`.trim());
      infoRow('상대방 달력 기준', order.partner.calendarType === 'lunar' ? '음력' : '양력');
    }
    if (order.applicant.concern) infoRow('현재 고민', order.applicant.concern);

    sectionTitle('사주팔자 원국 표');
    drawPillarTable(premiumSections.pillarDetails);

    const orderedSections = [
      ['오행 분석', premiumSections.ohaengAnalysis],
      ['십성 분석', premiumSections.sipseongAnalysis],
      ['핵심 성향', premiumSections.coreAnalysis],
      ['일/재물/사업운', premiumSections.workMoneyAnalysis],
      ['관계/궁합', premiumSections.relationshipAnalysis],
      ['기간운/시기별 조언', premiumSections.periodAnalysis],
      ['맞춤 답변', premiumSections.customAnswer],
      ['종합 조언', premiumSections.finalAdvice]
    ];

    for (const [title, body] of orderedSections) {
      sectionTitle(title);
      paragraph(body);
    }

    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  return filePath;
}

function buildPremiumPdfSections(order, promptPayload, aiSections) {
  const fallbackSections = fallbackAiSections(promptPayload);
  const mergedSections = { ...fallbackSections, ...(aiSections || {}) };
  const apiBase = promptPayload.apiSnapshots?.saju || promptPayload.apiSnapshots?.mansae || {};
  const pillars = extractPillars(apiBase, order.applicant);
  const pillarDetails = buildPillarDetails(pillars, apiBase);
  const fiveElements = extractDistribution(apiBase, ['오행', 'five', 'element']) || defaultElementDistribution(order.applicant);
  const tenGods = extractDistribution(apiBase, ['십성', 'tenGod', 'ten']) || defaultTenGodDistribution(order.applicant);
  const hasCompatibility = Boolean(promptPayload.apiSnapshots?.compatibility && order.partner?.name);

  return {
    pillarDetails,
    ohaengAnalysis: [
      buildDistributionSummary('오행', fiveElements),
      mergedSections['사주 원국 해석']
    ].filter(Boolean).join('\n\n'),
    sipseongAnalysis: [
      buildDistributionSummary('십성', tenGods),
      mergedSections['십성']
    ].filter(Boolean).join('\n\n'),
    coreAnalysis: [
      mergedSections['핵심 요약'],
      mergedSections['사주 원국 해석']
    ].filter(Boolean).join('\n\n'),
    workMoneyAnalysis: [
      mergedSections['재물운'],
      mergedSections['직업운']
    ].filter(Boolean).join('\n\n'),
    relationshipAnalysis: [
      mergedSections['애정운'],
      hasCompatibility ? mergedSections['궁합 참고 해석'] : '관계에서는 감정의 속도와 생활 리듬을 맞추는 것이 중요합니다. 상대와의 기대치를 미리 조율할수록 안정감이 커집니다.'
    ].filter(Boolean).join('\n\n'),
    periodAnalysis: [
      mergedSections['대운'],
      mergedSections['세운'],
      mergedSections['월운']
    ].filter(Boolean).join('\n\n'),
    customAnswer: mergedSections['고민에 대한 조언'] || mergedSections['실천 조언'],
    finalAdvice: [
      mergedSections['실천 조언'],
      mergedSections['주의할 점'],
      mergedSections['건강운']
    ].filter(Boolean).join('\n\n')
  };
}

function buildDistributionSummary(label, valueMap) {
  const entries = Object.entries(valueMap || {})
    .filter(([, value]) => Number(value || 0) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  if (!entries.length) return '';
  const total = entries.reduce((sum, [, value]) => sum + Number(value || 0), 0) || 1;
  const lines = entries.map(([key, value]) => `${key} ${((Number(value || 0) / total) * 100).toFixed(1)}%`);
  return `${label} 분포는 ${lines.join(', ')} 순으로 읽힙니다. 가장 두드러지는 기운을 중심으로 강점과 보완 포인트를 함께 해석했습니다.`;
}

function sanitizeCustomerFacingText(text) {
  const blocked = /(계산 확인 메모|saju api|period api|compatibility api|requiredfields|content-type|charset|raw json error|debug|fallback|mock|source|api 400)/i;
  const parts = String(text || '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !blocked.test(line));
  return parts.join('\n\n').replace(/\s{2,}/g, ' ').trim();
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
