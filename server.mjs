import 'dotenv/config';
import express from 'express';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();

const PORT = Number(process.env.PORT || 3000);
const EXPLICIT_BASE_URL = String(process.env.BASE_URL || process.env.SITE_URL || process.env.APP_BASE_URL || '').trim().replace(/\/$/, '');
const BASE_URL = (EXPLICIT_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_DIR = path.join(__dirname, 'public');
const generatingOrders = new Set();
const runtimeOrderStore = new Map();
const LUCKY_API_BASE_URL = (process.env.LUCKY_API_BASE_URL || 'https://luckyloveme.com').replace(/\/$/, '');
const DEFAULT_PERIOD_YEAR = Number(process.env.DEFAULT_PERIOD_YEAR || 2026);
const DEFAULT_PERIOD_MONTH = Number(process.env.DEFAULT_PERIOD_MONTH || 6);
const DEFAULT_PERIOD_DAY = Number(process.env.DEFAULT_PERIOD_DAY || 1);
const DEBUG_MODE = String(process.env.DEBUG_MODE || 'false').toLowerCase() === 'true';
const ALLOW_LOCAL_FALLBACK = process.env.ALLOW_LOCAL_FALLBACK != null
  ? String(process.env.ALLOW_LOCAL_FALLBACK).toLowerCase() === 'true'
  : String(process.env.USE_MOCK_DATA || 'false').toLowerCase() === 'true';
const UNKNOWN_BIRTH_TIME_DISPLAY = '출생시간 미상';
const UNKNOWN_BIRTH_TIME_REPORT_DISPLAY = '미상';
const UNKNOWN_BIRTH_TIME_FALLBACK = Object.freeze({ hour: '12', minute: '00', time: '12:00' });
const KOREAN_MOBILE_PHONE_REGEX = /^01[016789]\d{7,8}$/;

function normalizePhoneNumber(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidKoreanMobilePhone(value) {
  return KOREAN_MOBILE_PHONE_REGEX.test(String(value || ''));
}

function getPhoneValidationMessage(phone) {
  return phone
    ? '결제 진행을 위해 올바른 휴대폰 번호를 입력해 주세요.'
    : '결제 진행을 위해 휴대폰 번호를 입력해 주세요.';
}

function sanitizePaymentErrorMessage(message) {
  const raw = String(message || '').trim();
  if (!raw) return '결제 요청 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
  if (/recvphone\s*값을\s*확인하세요/i.test(raw)) {
    return '휴대폰 번호를 확인한 뒤 다시 시도해 주세요.';
  }
  return raw;
}

function parseOptionalBoolean(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return null;
}

const RESOLVED_PAYMENT_MODE = (() => {
  const explicitMode = String(process.env.PAYMENT_MODE || '').trim().toLowerCase();
  if (explicitMode === 'live') return 'live';
  if (explicitMode === 'mock') return 'mock';
  const booleanCandidates = [
    parseOptionalBoolean(process.env.USE_MOCK_PAYMENT),
    parseOptionalBoolean(process.env.MOCK_PAYMENT),
    parseOptionalBoolean(process.env.ENABLE_MOCK_PAY),
    parseOptionalBoolean(process.env.PAYAPP_MOCK)
  ].filter((value) => value !== null);
  if (booleanCandidates.length) {
    return booleanCandidates.some(Boolean) ? 'mock' : 'live';
  }
  return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'development' ? 'mock' : 'live';
})();

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
    provider: process.env.AI_PROVIDER || 'kie',
    apiKey: process.env.KIE_AI_API_KEY || process.env.AI_API_KEY || '',
    baseUrl: (process.env.AI_API_BASE_URL || 'https://api.kie.ai').replace(/\/$/, ''),
    path: process.env.AI_API_PATH || '/v1/chat/completions',
    style: process.env.AI_API_STYLE || 'chat_completions',
    model: process.env.AI_MODEL || 'gpt-5-2',
    temperature: Number(process.env.AI_TEMPERATURE || 0.4),
    maxTokens: Number(process.env.AI_MAX_TOKENS || 12000),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS || 180000),
    debugMode: DEBUG_MODE,
    singleSectionMode: String(process.env.AI_SINGLE_SECTION_MODE || 'false').toLowerCase() === 'true'
  },
  payapp: {
    apiUrl: process.env.PAYAPP_API_URL || 'https://api.payapp.kr/oapi/apiLoad.html',
    userid: process.env.PAYAPP_USERID || '',
    shopname: process.env.PAYAPP_SHOPNAME || '일상사주',
    linkKey: process.env.PAYAPP_LINK_KEY || '',
    linkValue: process.env.PAYAPP_LINK_VALUE || '',
    feedbackPath: process.env.PAYAPP_FEEDBACK_PATH || process.env.PAYAPP_CALLBACK_PATH || '/api/payapp/callback',
    returnPath: process.env.PAYAPP_RETURN_PATH || '/api/payapp/return',
    mode: RESOLVED_PAYMENT_MODE,
    mock: RESOLVED_PAYMENT_MODE === 'mock'
  },
  product: {
    singlePrice: Number(process.env.REPORT_PRICE_SINGLE || 18900),
    compatibilityPrice: Number(process.env.REPORT_PRICE_COMPATIBILITY || 36000),
    singleName: process.env.REPORT_PRODUCT_SINGLE || '프리미엄 사주 리포트',
    compatibilityName: process.env.REPORT_PRODUCT_COMPATIBILITY || '2인 사주(궁합 무료 진행)'
  },
  allowLocalFallback: ALLOW_LOCAL_FALLBACK
};

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));


app.get('/api/health', async (req, res) => {
  const publicBaseUrl = resolvePublicBaseUrl(req);
  res.json({
    ok: true,
    service: 'daon-premium-saju-service',
    payappReady: Boolean(CONFIG.payapp.userid && CONFIG.payapp.linkValue),
    paymentMode: CONFIG.payapp.mode,
    paymentBaseUrl: publicBaseUrl,
    paymentCallbackUrl: `${publicBaseUrl}${CONFIG.payapp.feedbackPath}`,
    paymentReturnUrl: `${publicBaseUrl}${CONFIG.payapp.returnPath}`,
    luckyConfigured: Boolean(CONFIG.lucky.apiKey),
    aiConfigured: Boolean(CONFIG.ai.apiKey),
    time: new Date().toISOString()
  });
});


if (CONFIG.ai.debugMode) {
  app.get('/api/debug/kie-smoke', async (req, res) => {
    try {
      const mode = ['smoke', 'compact_report', 'full_report'].includes(String(req.query.mode || ''))
        ? String(req.query.mode)
        : 'smoke';
      const candidate = ['configured', 'market', 'openai', 'all'].includes(String(req.query.candidate || ''))
        ? String(req.query.candidate)
        : 'all';
      const result = await runKieSmokeTest(mode, candidate);
      if (mode === 'smoke' && result?.ok) {
        return res.json({ ok: true, message: 'pong' });
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ ok: false, error: error.message || 'KIE smoke test failed' });
    }
  });
}

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
      hour: payload.birthTimeUnknown ? payload.birthHour : (payload.birthTime ? String(payload.birthTime).split(':')[0] || '' : ''),
      minute: payload.birthTimeUnknown ? payload.birthMinute : (payload.birthTime ? String(payload.birthTime).split(':')[1] || '' : ''),
      calendar: payload.calendarType,
      calendarType: payload.calendarType,
      gender: payload.gender,
      isLeapMonth: payload.isLeapMonth === true,
      birthTimeUnknown: payload.birthTimeUnknown,
      displayBirthTime: payload.birthTimeUnknown ? UNKNOWN_BIRTH_TIME_DISPLAY : (payload.birthTime || '')
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

app.get('/api/orders/create', async (_req, res) => {
  applyNoCacheHeaders(res);
  return res.status(405).json({
    ok: false,
    error: '이 엔드포인트는 POST 요청만 지원합니다.'
  });
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
      publicBaseUrl: resolvePublicBaseUrl(req),
      payment: {
        price: product.price,
        productName: product.name,
        mulNo: null,
        payState: 1,
        method: CONFIG.payapp.mock ? 'mock' : 'payapp',
        requestedMode: CONFIG.payapp.mode
      },
      artifacts: {},
      logs: []
    };
    await saveOrder(order);
    const payment = await createPaymentRequest(order, { publicBaseUrl: order.publicBaseUrl });
    order.payment = { ...order.payment, ...payment };
    updateOrderProgress(order, { status: 'payment_pending', currentStep: 'payment_pending', progress: getDefaultProgressForStep('payment_pending'), failedStep: null, failedBatch: null, failedSections: [], statusMessage: '결제 완료를 기다리고 있습니다.' });
    order.logs.push(logLine('payment_request_created', { mulNo: payment.mulNo || null }));
    await saveOrder(order);

    res.json({
      ok: true,
      orderId,
      paymentMode: CONFIG.payapp.mode,
      paymentUrl: payment.payUrl,
      statusUrl: buildOrderStatusPageUrl(orderId, order.publicBaseUrl)
    });
  } catch (error) {
    const userMessage = sanitizePaymentErrorMessage(error.message || '주문 생성에 실패했습니다.');
    await appendLog('order_create_error', { message: error.message, userMessage });
    res.status(400).json({ ok: false, error: userMessage, message: userMessage });
  }
});

function classifyPayappOutcome(incoming, payState) {
  const cancelledStates = [8, 9, 32, 64, 70, 71];
  if (payState === 4) return 'paid';
  if (cancelledStates.includes(payState)) return 'cancelled';
  if (payState === 10) return 'pending';
  const raw = JSON.stringify(incoming || {}).toLowerCase();
  if (/cancel|canceled|cancelled|취소/.test(raw)) return 'cancelled';
  if (/fail|failed|error|실패/.test(raw)) return 'failed';
  if (Number.isFinite(payState) && payState > 0) return 'failed';
  return 'received';
}

async function applyPayappPaymentResult(incoming, { source = 'callback' } = {}) {
  const orderId = String(incoming.var1 || incoming.orderId || '').trim();
  if (!orderId) throw new Error('주문 식별값(var1)이 없습니다.');
  const order = await readOrder(orderId);
  if (!order) throw new Error('주문을 찾을 수 없습니다.');

  const linkValue = String(incoming.linkval || incoming.linkValue || '');
  if (CONFIG.payapp.linkValue && linkValue && CONFIG.payapp.linkValue !== linkValue) {
    throw new Error('PayApp linkval 검증에 실패했습니다.');
  }

  const payState = Number(incoming.pay_state || incoming.payState || incoming.paystate || order.payment?.payState || 0);
  const price = Number(incoming.price || 0);
  if (price && price !== order.payment.price) {
    throw new Error('결제 금액 검증에 실패했습니다.');
  }

  order.payment = {
    ...order.payment,
    payState,
    mulNo: incoming.mul_no || incoming.mulNo || order.payment.mulNo,
    recvphone: incoming.recvphone || order.applicant.phone,
    payUrl: incoming.payurl || incoming.payUrl || order.payment.payUrl || null,
    tid: incoming.tid || order.payment.tid || null,
    lastFeedbackAt: new Date().toISOString(),
    lastSource: source
  };

  const outcome = classifyPayappOutcome(incoming, payState);
  if (outcome === 'paid') {
    const shouldTriggerGeneration = !isOrderCompleted(order);
    if (isOrderCompleted(order)) {
      order.status = 'completed';
    } else {
      updateOrderProgress(order, {
        status: 'queued',
        currentStep: 'queued',
        progress: getDefaultProgressForStep('queued'),
        failedStep: null,
        failedBatch: null,
        failedSections: [],
        statusMessage: buildQueuedReceiptMessage(order)
      });
    }
    order.logs.push(logLine('payment_success', { source, payState, mulNo: order.payment.mulNo, tid: order.payment.tid || null }));
    await saveOrder(order);
    if (shouldTriggerGeneration) triggerReportGeneration(order.id);
  } else if (outcome === 'cancelled') {
    updateOrderProgress(order, {
      status: 'payment_cancelled',
      currentStep: 'payment_cancelled',
      progress: getDefaultProgressForStep('payment_pending'),
      failedStep: null,
      failedBatch: null,
      failedSections: [],
      statusMessage: '결제가 완료되지 않았습니다. 다시 시도해 주세요.'
    });
    order.logs.push(logLine('payment_cancelled', { source, payState }));
    await saveOrder(order);
  } else if (outcome === 'failed') {
    updateOrderProgress(order, {
      status: 'failed',
      currentStep: 'payment_failed',
      progress: getDefaultProgressForStep('payment_pending'),
      failedStep: 'payment',
      failedBatch: null,
      failedSections: [],
      statusMessage: '결제가 완료되지 않았습니다. 다시 시도해 주세요.'
    });
    order.logs.push(logLine('payment_failed', { source, payState }));
    await saveOrder(order);
  } else if (outcome === 'pending') {
    updateOrderProgress(order, {
      status: 'payment_pending',
      currentStep: 'payment_pending',
      progress: getDefaultProgressForStep('payment_pending'),
      failedStep: null,
      failedBatch: null,
      failedSections: [],
      statusMessage: '결제 완료를 기다리고 있습니다.'
    });
    order.logs.push(logLine('payment_waiting', { source, payState }));
    await saveOrder(order);
  } else {
    order.logs.push(logLine('payment_feedback_received', { source, payState }));
    await saveOrder(order);
  }

  return order;
}

app.all([CONFIG.payapp.feedbackPath, '/api/payapp/feedback', '/api/payapp/callback'], async (req, res) => {
  const incoming = { ...req.query, ...req.body };
  try {
    const order = await applyPayappPaymentResult(incoming, { source: 'callback' });
    await appendLog('payapp_callback_received', { orderId: order.id, payState: order.payment?.payState || null, mode: CONFIG.payapp.mode });
    res.status(200).send('SUCCESS');
  } catch (error) {
    await appendLog('payapp_callback_error', { message: error.message, incoming });
    res.status(200).send('FAIL');
  }
});

app.all(CONFIG.payapp.returnPath, async (req, res) => {
  const incoming = { ...req.query, ...req.body };
  const fallbackOrderId = String(incoming.var1 || incoming.orderId || '').trim();
  try {
    const order = await applyPayappPaymentResult(incoming, { source: 'return' });
    await appendLog('payapp_return_received', { orderId: order.id, payState: order.payment?.payState || null, mode: CONFIG.payapp.mode });
    return res.redirect(buildOrderStatusPageUrl(order.id, resolvePublicBaseUrl(req, order)));
  } catch (error) {
    await appendLog('payapp_return_error', { message: error.message, incoming });
    if (fallbackOrderId) {
      return res.redirect(buildOrderStatusPageUrl(fallbackOrderId, resolvePublicBaseUrl(req)));
    }
    return res.status(400).send('결제가 완료되지 않았습니다. 다시 시도해 주세요.');
  }
});

app.get('/api/orders/:orderId/status', async (req, res) => {
  const order = await readOrder(req.params.orderId);
  applyNoCacheHeaders(res);
  if (!order) return res.status(404).json({ error: '주문을 찾을 수 없습니다.' });

  const publicStatus = getPublicOrderStatus(order.status);
  const canDeliverHtml = publicStatus === 'completed' && order.runtimeReport && !order.runtimeReport.deliveredAt;
  const deliveredSections = canDeliverHtml ? cloneRuntimeOrder(order.runtimeReport.sections || {}) : null;
  const payload = {
    orderId: order.id,
    status: publicStatus,
    progress: getOrderProgress(order),
    currentStep: order.currentStep || null,
    failedStep: order.failedStep || null,
    failedBatch: order.failedBatch || null,
    failedSections: Array.isArray(order.failedSections) ? order.failedSections : [],
    message: buildStatusMessage(order),
    viewMode: publicStatus === 'completed' ? 'html' : null,
    reportSections: deliveredSections,
    reportExpired: publicStatus === 'completed' && !canDeliverHtml,
    applicant: {
      name: order.applicant?.name || '',
      birthDate: [order.applicant?.birthYear, order.applicant?.birthMonth, order.applicant?.birthDay].filter(Boolean).join('-'),
      birthTimeUnknown: order.applicant?.birthTimeUnknown === true,
      displayBirthTime: order.applicant?.birthTimeUnknown === true ? UNKNOWN_BIRTH_TIME_REPORT_DISPLAY : (order.applicant?.birthTime || ''),
      calendarType: formatCalendarTypeForLucky(order.applicant?.calendarType || 'solar')
    },
    reportNote: order.applicant?.birthTimeUnknown === true
      ? '출생시간이 확인되지 않아 시주를 기준으로 한 일부 세부 해석은 제한적으로 참고하는 것이 좋습니다.'
      : '',
    statusUrl: buildOrderStatusPageUrl(order.id, order.publicBaseUrl),
    productName: order.product.name,
    productType: order.product?.type || 'single',
    expectedDurationText: order.product?.type === 'compatibility' ? '약 5~10분' : '약 3~7분',
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
  if (canDeliverHtml) {
    order.runtimeReport.deliveredAt = new Date().toISOString();
    order.runtimeReport.sections = null;
    await saveOrder(order);
  }
  res.json(payload);
});

async function handleOrderLookup(req, res) {
  applyNoCacheHeaders(res);
  return res.status(410).json({
    ok: false,
    error: '이 버전에서는 주문 재조회 기능을 제공하지 않습니다. 결제 완료 후 현재 화면에서 리포트를 확인해 주세요.'
  });
}

app.get('/api/orders/lookup', handleOrderLookup);
app.post('/api/orders/lookup', handleOrderLookup);

app.get('/mock-pay/:orderId', async (req, res) => {
  if (!CONFIG.payapp.mock) return res.status(404).send('Not found');
  const order = await readOrder(req.params.orderId);
  if (!order) return res.status(404).send('Order not found');
  res.send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mock Pay</title><style>body{font-family:sans-serif;background:#f7f3ee;padding:24px}.card{max-width:420px;margin:0 auto;background:#fff;padding:24px;border-radius:20px;border:1px solid #eadfd2}.btn{display:block;margin-top:12px;padding:14px 16px;border-radius:14px;text-align:center;text-decoration:none;font-weight:700}.ok{background:#cf8f7a;color:#fff}.cancel{background:#fff;border:1px solid #eadfd2;color:#352c29}</style></head><body><div class="card"><h1>Mock 결제 페이지</h1><p>${escapeHtml(order.product.name)} / ${order.product.price.toLocaleString('ko-KR')}원</p><a class="btn ok" href="/mock-pay/${encodeURIComponent(order.id)}/complete">결제 성공 처리</a><a class="btn cancel" href="/mock-pay/${encodeURIComponent(order.id)}/cancel">결제 취소 처리</a></div></body></html>`);
});

app.get('/mock-pay/:orderId/complete', async (req, res) => {
  if (!CONFIG.payapp.mock) return res.status(404).send('Not found');
  const order = await readOrder(req.params.orderId);
  if (!order) return res.status(404).send('Order not found');
  order.payment.payState = 4;
  order.payment.mulNo = order.payment.mulNo || `mock_${Date.now()}`;
  updateOrderProgress(order, {
    status: 'queued',
    currentStep: 'queued',
    progress: getDefaultProgressForStep('queued'),
    failedStep: null,
    failedBatch: null,
    failedSections: [],
    statusMessage: buildQueuedReceiptMessage(order)
  });
  order.logs.push(logLine('mock_payment_success', {}));
  await saveOrder(order);
  triggerReportGeneration(order.id);
  res.redirect(buildOrderStatusPageUrl(order.id, order.publicBaseUrl));
});

app.get('/mock-pay/:orderId/cancel', async (req, res) => {
  if (!CONFIG.payapp.mock) return res.status(404).send('Not found');
  const order = await readOrder(req.params.orderId);
  if (!order) return res.status(404).send('Order not found');
  order.status = 'payment_cancelled';
  order.payment.payState = 9;
  order.logs.push(logLine('mock_payment_cancelled', {}));
  await saveOrder(order);
  res.redirect(buildOrderStatusPageUrl(order.id, order.publicBaseUrl));
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
    if (!order) return;
    if (isOrderCompleted(order) && order.runtimeReport?.sections) {
      console.log('[ORDER] completed order reuse', JSON.stringify({ orderId: order.id, viewMode: 'html' }));
      return;
    }
    if (isOrderCompleted(order)) return;

    updateOrderProgress(order, { status: 'generating', progress: getDefaultProgressForStep('generation'), currentStep: 'generation', failedStep: null, failedBatch: null, failedSections: [], statusMessage: buildGeneratingMessage('generation') });
    order.logs.push(logLine('generation_started', {}));
    await saveOrder(order);

    const warnings = [...(order.warnings || [])];
    const apiSnapshots = {};
    const applicantPayload = toLuckyFlatPayload(order.applicant);
    const hasPerson1 = Boolean(order.applicant?.name && order.applicant?.birthYear && order.applicant?.birthMonth && order.applicant?.birthDay);
    const hasPerson2 = Boolean(order.partner?.name && order.partner?.birthYear && order.partner?.birthMonth && order.partner?.birthDay && order.partner?.gender);
    console.log('[ORDER] generation payload loaded', JSON.stringify({
      orderId: order.id,
      productType: order.product?.type || 'single',
      compatibilityRequested: Boolean(order.compatibilityRequested),
      hasPerson1,
      hasPerson2
    }));

    updateOrderProgress(order, { progress: getDefaultProgressForStep('mansae'), currentStep: 'mansae', failedStep: null, statusMessage: buildGeneratingMessage('mansae') });
    await saveOrder(order);
    const mansaeResult = await optionalApiCall('mansae', CONFIG.lucky.mansaeUrl, [applicantPayload], warnings, false);
    if (mansaeResult.data) {
      apiSnapshots.mansae = mansaeResult.data;
      logLuckyResponseDiagnostics('mansae', mansaeResult.data, applicantPayload);
    }

    updateOrderProgress(order, { progress: getDefaultProgressForStep('saju'), currentStep: 'saju', failedStep: null, statusMessage: buildGeneratingMessage('saju') });
    await saveOrder(order);
    const sajuCandidates = [{ ...applicantPayload }];
    const sajuResult = await optionalApiCall('saju', CONFIG.lucky.sajuUrl, sajuCandidates, warnings, true);
    if (sajuResult.data) {
      apiSnapshots.saju = sajuResult.data;
      logLuckyResponseDiagnostics('saju', sajuResult.data, applicantPayload);
    }

    updateOrderProgress(order, { progress: getDefaultProgressForStep('period'), currentStep: 'period', failedStep: null, statusMessage: buildGeneratingMessage('period') });
    await saveOrder(order);
    const periodCandidates = buildPeriodPayloadCandidates(applicantPayload);
    const periodResult = await optionalApiCall('period', CONFIG.lucky.periodUrl, periodCandidates, warnings, true);
    if (periodResult.data) apiSnapshots.period = periodResult.data;

    if (shouldCallCompatibility(order)) {
      updateOrderProgress(order, { progress: getDefaultProgressForStep('compatibility_api'), currentStep: 'compatibility_api', failedStep: null, statusMessage: buildGeneratingMessage('compatibility_api') });
      await saveOrder(order);
      const compatibilityPayload = buildCompatibilityPayload(order.applicant, order.partner, order.partner?.memo || '');
      console.log('[COMPATIBILITY API] request start');
      console.log('[COMPATIBILITY API] payload check:', JSON.stringify({
        hasPerson1: Boolean(compatibilityPayload.person1),
        hasPerson2: Boolean(compatibilityPayload.person2),
        person1HasBirthYear: Boolean(compatibilityPayload.person1?.birthYear),
        person1HasBirthMonth: Boolean(compatibilityPayload.person1?.birthMonth),
        person1HasBirthDay: Boolean(compatibilityPayload.person1?.birthDay),
        person2HasBirthYear: Boolean(compatibilityPayload.person2?.birthYear),
        person2HasBirthMonth: Boolean(compatibilityPayload.person2?.birthMonth),
        person2HasBirthDay: Boolean(compatibilityPayload.person2?.birthDay),
        person1Keys: Object.keys(compatibilityPayload.person1 || {}),
        person2Keys: Object.keys(compatibilityPayload.person2 || {})
      }));
      const compatibilityResult = await optionalApiCall('compatibility', CONFIG.lucky.compatibilityUrl, [compatibilityPayload], warnings, true);
      if (compatibilityResult.data) apiSnapshots.compatibility = compatibilityResult.data;
    }

    if (!apiSnapshots.saju) {
      const error = new Error('핵심 사주 데이터 호출에 실패했습니다.');
      error.failedStep = 'saju';
      error.progress = 62;
      throw error;
    }
    if (!apiSnapshots.period) {
      const error = new Error('기간운 데이터 호출에 실패했습니다.');
      error.failedStep = 'period';
      error.progress = 72;
      throw error;
    }
    if (shouldCallCompatibility(order) && !apiSnapshots.compatibility) {
      const error = new Error('궁합 데이터 호출에 실패했습니다.');
      error.failedStep = 'compatibility';
      error.progress = 84;
      throw error;
    }

    updateOrderProgress(order, { progress: getDefaultProgressForStep('kie_ai'), currentStep: 'kie_ai', failedStep: null, statusMessage: buildGeneratingMessage('kie_ai') });
    await saveOrder(order);
    const promptPayload = buildAiPromptPayload(order, apiSnapshots, warnings);
    const aiSections = await generateAiSections(promptPayload, order);

    updateOrderProgress(order, { progress: 98, currentStep: 'html_render', failedStep: null, statusMessage: buildGeneratingMessage('html_render') });
    await saveOrder(order);
    console.log('[REPORT HTML] render start', JSON.stringify({ orderId: order.id, sections: Object.keys(aiSections || {}) }));

    updateOrderProgress(order, { status: 'completed', progress: 100, currentStep: 'completed', failedStep: null, failedBatch: null, failedSections: [], statusMessage: buildGeneratingMessage('completed') });
    order.runtimeReport = {
      sections: aiSections,
      deliveredAt: null,
      copyReady: true,
      createdAt: new Date().toISOString()
    };
    order.artifacts = { partialAiSections: null };
    order.logs.push(logLine('generation_completed', { viewMode: 'html' }));
    await saveOrder(order);
    console.log('[REPORT HTML] render completed', JSON.stringify({ orderId: order.id, sectionCount: Object.keys(aiSections || {}).length }));
    console.log('[REPORT HTML] copy button ready', JSON.stringify({ orderId: order.id }));
    console.log('[ORDER] status completed', JSON.stringify({ orderId: order.id, status: order.status, viewMode: 'html' }));
  } catch (error) {
    const order = await readOrder(orderId);
    if (order) {
      const currentStep = error.currentStep || order.currentStep || 'generation';
      const failedStep = error.failedStep || (currentStep === 'generation' ? 'generation' : 'kie_ai');
      const progress = Number.isFinite(Number(error.progress)) ? Number(error.progress) : getDefaultProgressForStep(currentStep);
      const failedBatch = error.failedBatch || (failedStep === 'kie_ai' ? currentStep : null);
      const failedSections = Array.isArray(error.failedSections) ? Array.from(new Set(error.failedSections.filter(Boolean))) : [];
      updateOrderProgress(order, {
        status: 'failed',
        progress,
        currentStep,
        failedStep,
        failedBatch,
        failedSections,
        statusMessage: error.userMessage || buildFailureMessage(failedStep)
      });
      order.logs.push(logLine('generation_failed', { failedStep, currentStep, failedBatch, failedSections, message: error.message }));
      await saveOrder(order);
      console.log('[ORDER] status failed', JSON.stringify({ orderId: order.id, failedStep, currentStep, failedBatch, failedSections, progress }));
    }
    await appendLog('generation_failed', { orderId, failedStep: error.failedStep || 'generation', message: error.message });
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
  if (label === 'period') {
    console.log('[PERIOD API] request start');
    console.log('[PERIOD API] endpoint check:', JSON.stringify({
      url: sanitizeLuckyUrlForLog(url),
      method: 'POST',
      headers: ['Content-Type: application/json; charset=utf-8', 'Accept: application/json']
    }));
  }
  if (label === 'compatibility') {
    console.log('[COMPATIBILITY API] request start');
  }
  const candidates = (Array.isArray(payloadCandidates) ? payloadCandidates : [payloadCandidates]).map((payload) => {
    if (!payload || typeof payload !== 'object') return payload;
    const clone = { ...payload };
    return clone;
  });
  if (!CONFIG.lucky.apiKey) {
    throw new Error('LUCKY_API_KEY가 설정되지 않았습니다.');
  }
  const authVariants = resolveLuckyAuthVariants();
  let lastError = new Error(`${label} API 호출 실패`);

  for (let payloadIndex = 0; payloadIndex < candidates.length; payloadIndex += 1) {
    const payload = candidates[payloadIndex];
    console.log(`[LUCKY API] final request payload (${label}): ${JSON.stringify(sanitizeLuckyPayloadForLog(payload))}`);
    if (label === 'period') {
      console.log('[PERIOD API] payload check:', JSON.stringify({
        fieldNames: Object.keys(payload || {}).filter((key) => !key.startsWith('__')),
        calendarType: payload?.calendarType || null,
        calendar: payload?.calendar || null,
        targetMode: payload?.__periodMode || (payload?.targetDate ? 'targetDate' : payload?.targetYear || payload?.targetMonth ? 'targetYearMonth' : payload?.targetDates ? 'targetDates' : 'unknown'),
        targetDateFormat: payload?.targetDate || (Array.isArray(payload?.targetDates) ? payload.targetDates[0] : null) || null,
        fallbackAttempt: payloadIndex > 0
      }));
    }
    const requestPayload = payload && typeof payload === 'object'
      ? Object.fromEntries(Object.entries(payload).filter(([key]) => !key.startsWith('__')))
      : payload;
    for (const authVariant of authVariants) {
      try {
        const headers = {
          'Content-Type': 'application/json; charset=utf-8',
          Accept: 'application/json'
        };
        let requestUrl = url;
        const body = JSON.stringify(requestPayload);
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
        if (label === 'period') console.log(`[PERIOD API] status: ${response.status}`);
        if (label === 'compatibility') console.log(`[COMPATIBILITY API] status: ${response.status}`);
        if (!response.ok) {
          const sanitizedBody = sanitizeApiErrorBodyForLog(text);
          if (label === 'period') console.log(`[PERIOD API] error body: ${sanitizedBody}`);
          if (label === 'compatibility') console.log(`[COMPATIBILITY API] error body: ${sanitizedBody}`);
          await appendLog('lucky_api_attempt_failed', {
            label,
            url: sanitizeLuckyUrlForLog(requestUrl),
            authMode: authVariant.mode,
            authHeader: authVariant.mode === 'header' ? authVariant.header : null,
            status: response.status,
            bodyPreview: sanitizedBody.slice(0, 400)
          });
          lastError = new Error(`${label} API ${response.status}: ${sanitizedBody.slice(0, 160)}`);
          lastError.failedStep = label;
          lastError.progress = getDefaultProgressForStep(label);
          continue;
        }
        const data = safeJsonParse(text);
        if (label === 'period') console.log('[PERIOD API] result keys:', JSON.stringify(safeObjectKeys(data)));
        if (label === 'compatibility') console.log('[COMPATIBILITY API] result keys:', JSON.stringify(safeObjectKeys(data)));
        return data;
      } catch (error) {
        lastError = error;
        if (!lastError.failedStep) lastError.failedStep = label;
        if (!Number.isFinite(Number(lastError.progress))) lastError.progress = getDefaultProgressForStep(label);
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
  const inputBirthTime = String(
    fallbackPerson?.birthTime
    || fallbackPerson?.time
    || ((fallbackPerson?.birthHour || fallbackPerson?.hour) ? `${String(fallbackPerson?.birthHour || fallbackPerson?.hour).padStart(2, '0')}:${String(fallbackPerson?.birthMinute || fallbackPerson?.minute || '00').padStart(2, '0')}` : '')
  );
  const expectedHourBranch = guessExpectedHourBranch(inputBirthTime);
  const selectedHourPillar = pillarDebug?.pillars?.hour || '';
  const actualHourBranch = normalizeBranchChar(selectedHourPillar.slice(1));
  console.log(`[LUCKY API] candidate pillar fields (${label}): ${JSON.stringify(pillarDebug.candidates.slice(0, 12))}`);
  console.log(`[LUCKY API] selected pillar paths (${label}): ${JSON.stringify(pillarDebugToResponsePaths(pillarDebug))}`);
  console.log(`[LUCKY API] selected birth pillars (${label}): ${JSON.stringify(pillarDebug.pillars)}`);
  console.log('[HOUR PILLAR DIAG]', JSON.stringify({
    label,
    inputBirthTime,
    inputBirthHour: String(fallbackPerson?.birthHour || fallbackPerson?.hour || ''),
    inputBirthMinute: String(fallbackPerson?.birthMinute || fallbackPerson?.minute || ''),
    expectedHourBranch,
    actualHourBranch,
    selectedHourPillar,
    selectedHourPath: pillarDebug?.selectedPaths?.hour || '',
    rawBirthInfo: summarizeLooseValue(searchLooseValue(data, [['birthinfo'], ['birth', 'info'], ['출생', '정보']]), 6),
    rawHourGanji: summarizeLooseValue(searchLooseValue(data, [['hourganji'], ['hour', 'ganji'], ['시간', '간지']]), 6),
    rawGanjiHour: summarizeLooseValue(searchLooseValue(data, [['ganji', 'hour'], ['ganjihour']]), 6),
    rawPillarsHour: summarizeLooseValue(searchLooseValue(data, [['pillars', 'hour'], ['hour', 'pillar'], ['시주']]), 6),
    useYajasiRule: fallbackPerson?.useYajasiRule ?? true,
    localHourMatch: Boolean(actualHourBranch && expectedHourBranch && actualHourBranch === expectedHourBranch),
    hourCandidates: (pillarDebug?.candidates || []).filter((item) => item.type === 'hour').slice(0, 6)
  }));
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

async function createPaymentRequest(order, options = {}) {
  const publicBaseUrl = resolvePublicBaseUrl(null, { ...order, publicBaseUrl: options.publicBaseUrl || order.publicBaseUrl || '' });
  if (CONFIG.payapp.mock) {
    return {
      mulNo: `mock_${Date.now()}`,
      payUrl: `${publicBaseUrl}/mock-pay/${encodeURIComponent(order.id)}`,
      callbackUrl: `${publicBaseUrl}${CONFIG.payapp.feedbackPath}`,
      returnUrl: `${publicBaseUrl}${CONFIG.payapp.returnPath}?orderId=${encodeURIComponent(order.id)}`
    };
  }
  assertLivePaymentBaseUrl(publicBaseUrl);
  if (!CONFIG.payapp.userid) throw new Error('PAYAPP_USERID가 설정되지 않았습니다.');
  if (!CONFIG.payapp.linkValue) throw new Error('PAYAPP_LINK_VALUE가 설정되지 않았습니다.');

  const recvphone = normalizePhoneNumber(order.applicant.phone || order.customerPhone || '');
  if (!isValidKoreanMobilePhone(recvphone)) {
    throw new Error(getPhoneValidationMessage(recvphone));
  }

  const callbackUrl = `${publicBaseUrl}${CONFIG.payapp.feedbackPath}`;
  const returnUrl = `${publicBaseUrl}${CONFIG.payapp.returnPath}?orderId=${encodeURIComponent(order.id)}`;
  const form = new URLSearchParams({
    cmd: 'payrequest',
    userid: CONFIG.payapp.userid,
    shopname: CONFIG.payapp.shopname,
    goodname: order.product.name,
    price: String(order.product.price),
    recvphone,
    feedbackurl: callbackUrl,
    returnurl: returnUrl,
    var1: order.id,
    var2: order.applicant.email || ''
  });
  if (CONFIG.payapp.linkKey) form.set('linkkey', CONFIG.payapp.linkKey);
  if (CONFIG.payapp.linkValue) form.set('linkval', CONFIG.payapp.linkValue);

  console.log('[PAYAPP REQUEST]', JSON.stringify({
    orderId: order.id,
    mode: CONFIG.payapp.mode,
    recvphone,
    callbackUrl,
    returnUrl
  }));

  const response = await fetch(CONFIG.payapp.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    body: form.toString()
  });
  const raw = await response.text();
  if (!response.ok) {
    console.error('[PAYAPP RESPONSE ERROR]', raw || `HTTP ${response.status}`);
    throw new Error(`PayApp 요청 실패: ${response.status}`);
  }
  const parsed = Object.fromEntries(new URLSearchParams(raw));
  const payUrl = String(parsed.payurl || '').trim();
  if (String(parsed.state) !== '1' || !payUrl) {
    console.error('[PAYAPP RESPONSE ERROR]', raw);
    throw new Error(sanitizePaymentErrorMessage(parsed.errorMessage || parsed.message || 'PayApp 결제 URL을 생성하지 못했습니다.'));
  }
  if (/(localhost|127\.0\.0\.1)/i.test(payUrl) || /\/mock-pay\//i.test(payUrl)) {
    console.error('[PAYAPP RESPONSE ERROR]', `Invalid live payUrl: ${payUrl}`);
    throw new Error('실제 결제 URL 설정이 올바르지 않습니다. 잠시 후 다시 시도해 주세요.');
  }
  return {
    mulNo: parsed.mul_no || null,
    payUrl,
    recvphone,
    callbackUrl,
    returnUrl
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
  if (input.applicant.birthTimeUnknown || !birthTime) warnings.push('출생시간이 확인되지 않아 시주를 기준으로 한 일부 세부 해석은 제한적으로 참고하는 것이 좋습니다.');
  if (!input.applicant.birthTimeUnknown && /^(23|00|01):/.test(birthTime)) warnings.push('야자시/조자시 구간 여부를 확인하는 메모를 함께 포함합니다.');
  if (input.applicant.calendarType === 'lunar' && input.applicant.isLeapMonth === 'unknown') warnings.push('음력 생일이며 윤달 여부가 불확실해 확인 메모를 포함합니다.');
  if (input.partner?.memo && !hasPartnerCoreFields(input.partner)) warnings.push('상대 정보가 일부만 입력되어 궁합 API 대신 관계 관련 참고 조언 중심으로 정리합니다.');
  return warnings;
}

function getPublicOrderStatus(status) {
  return status === 'ready' ? 'completed' : status;
}

function isOrderCompleted(order) {
  return ['ready', 'completed'].includes(order?.status);
}

function getDefaultProgressForStep(step) {
  const map = {
    created: 0,
    payment_pending: 5,
    queued: 10,
    payment_success: 10,
    generation: 12,
    mansae: 25,
    saju: 35,
    period: 45,
    compatibility_api: 55,
    kie_ai: 60,
    core: 88,
    timing: 90,
    analysis: 92,
    life: 94,
    concern: 96,
    compatibility: 97,
    html_render: 98,
    completed: 100
  };
  return map[step] ?? 12;
}

function getOrderProgress(order) {
  if (Number.isFinite(Number(order?.progress))) return Number(order.progress);
  return getDefaultProgressForStep(getPublicOrderStatus(order?.status));
}

function applyNoCacheHeaders(res) {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
    'Surrogate-Control': 'no-store'
  });
}

function updateOrderProgress(order, updates = {}) {
  if (!order || typeof order !== 'object') return order;
  if (updates.status) order.status = updates.status;
  if (updates.currentStep) order.currentStep = updates.currentStep;
  if ('failedStep' in updates) order.failedStep = updates.failedStep || null;
  if ('failedBatch' in updates) order.failedBatch = updates.failedBatch || null;
  if ('failedSections' in updates) {
    order.failedSections = Array.isArray(updates.failedSections)
      ? Array.from(new Set(updates.failedSections.filter(Boolean)))
      : [];
  } else if (updates.status && updates.status !== 'failed') {
    order.failedSections = [];
  }
  if (updates.status && updates.status !== 'failed' && !('failedBatch' in updates)) order.failedBatch = null;
  if ('statusMessage' in updates) order.statusMessage = String(updates.statusMessage || '').trim();
  if (Number.isFinite(Number(updates.progress))) order.progress = Number(updates.progress);
  order.updatedAt = new Date().toISOString();
  return order;
}

function buildFailureMessage(failedStep) {
  switch (failedStep) {
    case 'period':
      return '리포트 해석 생성 단계에서 일시적인 문제가 발생했습니다. 잠시 후 다시 확인해 주세요.';
    case 'compatibility':
      return '리포트 해석 생성 단계에서 일시적인 문제가 발생했습니다. 잠시 후 다시 확인해 주세요.';
    case 'kie_ai':
      return '리포트 해석 생성 단계에서 일시적인 문제가 발생했습니다. 잠시 후 다시 확인해 주세요.';
    case 'saju':
      return '리포트 해석 생성 단계에서 일시적인 문제가 발생했습니다. 잠시 후 다시 확인해 주세요.';
    default:
      return '리포트 해석 생성 단계에서 일시적인 문제가 발생했습니다. 잠시 후 다시 확인해 주세요.';
  }
}

function buildQueuedReceiptMessage(order) {
  return [
    '리포트 생성 중입니다.',
    '',
    '이 페이지를 닫지 말고 잠시만 기다려 주세요.',
    '생성 완료 후 리포트가 현재 화면에 표시됩니다.',
    '',
    '예상 소요 시간:',
    '1인 리포트: 약 3~7분',
    '2인 리포트: 약 5~10분',
    '',
    '2인 궁합 리포트는 분석 내용이 많아 몇 분 정도 소요될 수 있습니다.'
  ].join('\n');
}

function buildGeneratingMessage(step) {
  const currentStep = String(step || '').trim();
  switch (currentStep) {
    case 'queued':
    case 'payment_success':
      return buildQueuedReceiptMessage({});
    case 'generation':
      return '리포트 생성 중입니다. 이 페이지를 닫지 말고 잠시만 기다려 주세요. 생성 완료 후 리포트가 현재 화면에 표시됩니다.';
    case 'mansae':
    case 'saju':
      return '입력하신 생년월일시를 바탕으로 사주 정보를 계산하고 있습니다. 이 페이지를 닫지 말고 잠시만 기다려 주세요.';
    case 'period':
    case 'compatibility_api':
      return '운의 흐름과 관계 참고 데이터를 정리하고 있습니다. 이 페이지를 닫지 말고 잠시만 기다려 주세요.';
    case 'kie_ai':
    case 'core':
    case 'timing':
    case 'analysis':
    case 'life':
    case 'concern':
    case 'compatibility':
      return '리포트 생성 중입니다. 사주 원국과 운의 흐름을 바탕으로 해석 문장을 작성하고 있습니다. 이 페이지를 닫지 말고 잠시만 기다려 주세요.';
    case 'html_render':
      return '완성된 해석 내용을 모바일 리포트 화면으로 정리하고 있습니다. 이 페이지를 닫지 말고 잠시만 기다려 주세요.';
    case 'completed':
      return '리포트 생성이 완료되었습니다. 현재 화면에서 전체 내용을 복사해 보관해 주세요.';
    default:
      return '리포트 제작 중입니다. 이 페이지를 닫아도 제작은 계속 진행됩니다.';
  }
}

function buildStatusMessage(order) {
  if (order?.statusMessage) return String(order.statusMessage);
  const publicStatus = getPublicOrderStatus(order?.status);
  switch (publicStatus) {
    case 'payment_pending':
      return '결제 승인 여부를 확인하고 있습니다.';
    case 'queued':
    case 'payment_success':
      return buildQueuedReceiptMessage(order);
    case 'generating':
      return buildGeneratingMessage(order?.currentStep || 'generation');
    case 'completed':
      return '리포트 생성이 완료되었습니다. 현재 화면에서 전체 내용을 복사해 보관해 주세요.';
    case 'payment_cancelled':
      return '결제가 취소되어 결과물 생성이 진행되지 않았습니다.';
    case 'failed':
      return buildFailureMessage(order?.failedStep);
    default:
      return '주문 상태를 확인하고 있습니다.';
  }
}

function normalizeOrderInput(input) {
  const applicantSource = {
    ...(input.applicant || input.person1 || {}),
    phone: input?.applicant?.phone || input?.person1?.phone || input.customerPhone || input.phone || '',
    customerPhone: input?.applicant?.customerPhone || input?.person1?.customerPhone || input.customerPhone || input.phone || ''
  };
  const partnerSource = input.partner || input.person2 || null;
  const applicant = normalizeApplicant(applicantSource);
  const partner = partnerSource ? normalizeApplicant(partnerSource, true) : null;
  return {
    compatibilityRequested: Boolean(input.compatibilityRequested || input.productType === 'compatibility' || hasPartnerCoreFields(partner)),
    applicant,
    partner,
    person1: applicant,
    person2: partner,
    phone: applicant.phone,
    customerPhone: applicant.phone
  };
}

function normalizeApplicant(raw, isPartner = false) {
  const dateParts = parseBirthDateParts(raw.birthDate || raw.date || '');
  const timeParts = parseBirthTimeParts(raw.birthTime || raw.time || '');
  const birthYear = normalizeYearValue(raw.birthYear || raw.year || dateParts.year || '');
  const birthMonth = normalizeMonthDayValue(raw.birthMonth || raw.month || dateParts.month || '');
  const birthDay = normalizeMonthDayValue(raw.birthDay || raw.day || dateParts.day || '');
  const birthTimeUnknown = raw.birthTimeUnknown === true || raw.birthTimeUnknown === 'true' || raw.birthTimeUnknown === 'unknown';
  const normalizedBirthTime = normalizeTime(raw.birthTime || raw.time || '');
  const normalizedTimeParts = parseBirthTimeParts(normalizedBirthTime);
  const birthHour = normalizeHourMinuteValue(raw.birthHour || raw.hour || normalizedTimeParts.hour || timeParts.hour || '', 23);
  const birthMinute = normalizeHourMinuteValue(raw.birthMinute || raw.minute || normalizedTimeParts.minute || timeParts.minute || '', 59);
  const resolvedBirthHour = birthTimeUnknown ? (birthHour || UNKNOWN_BIRTH_TIME_FALLBACK.hour) : birthHour;
  const resolvedBirthMinute = birthTimeUnknown ? (birthMinute || UNKNOWN_BIRTH_TIME_FALLBACK.minute) : (birthMinute || (birthHour ? '00' : ''));
  const combinedBirthTime = resolvedBirthHour || resolvedBirthMinute ? `${String(resolvedBirthHour || UNKNOWN_BIRTH_TIME_FALLBACK.hour).padStart(2, '0')}:${String(resolvedBirthMinute || UNKNOWN_BIRTH_TIME_FALLBACK.minute).padStart(2, '0')}` : '';
  const displayBirthTime = birthTimeUnknown
    ? UNKNOWN_BIRTH_TIME_DISPLAY
    : (normalizedBirthTime || combinedBirthTime || '');
  return {
    name: String(raw.name || '').trim(),
    gender: raw.gender === 'male' ? 'male' : raw.gender === 'female' ? 'female' : '',
    birthYear,
    birthMonth,
    birthDay,
    birthTime: birthTimeUnknown ? '' : (normalizedBirthTime || combinedBirthTime || ''),
    birthTimeUnknown,
    birthHour: resolvedBirthHour,
    birthMinute: resolvedBirthMinute,
    displayBirthTime,
    fallbackBirthHour: birthTimeUnknown ? UNKNOWN_BIRTH_TIME_FALLBACK.hour : '',
    fallbackBirthMinute: birthTimeUnknown ? UNKNOWN_BIRTH_TIME_FALLBACK.minute : '',
    calendarType: normalizeCalendarType(raw.calendarType || raw.calendar || 'solar'),
    isLeapMonth: normalizeLeap(raw.isLeapMonth),
    phone: isPartner ? '' : normalizePhoneNumber(raw.phone || raw.customerPhone || ''),
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
  if (!a.phone) throw new Error(getPhoneValidationMessage(''));
  if (!isValidKoreanMobilePhone(a.phone)) throw new Error(getPhoneValidationMessage(a.phone));
  if (input.compatibilityRequested && !hasPartnerCoreFields(input.partner)) {
    throw new Error('2인 사주는 상대방 핵심 정보를 함께 입력해 주세요.');
  }
}

function hasPartnerCoreFields(partner) {
  return Boolean(partner && partner.name && partner.gender && partner.birthYear && partner.birthMonth && partner.birthDay);
}

function shouldCallCompatibility(order) {
  return hasPartnerCoreFields(order.partner);
}

function toLuckyFlatPayload(person) {
  const birthTimeUnknown = person.birthTimeUnknown === true || person.birthTimeUnknown === 'true';
  const normalizedBirthTime = normalizeTime(person.birthTime || person.time || '');
  const [hourRaw, minuteRaw] = String(normalizedBirthTime || '').split(':');
  const year = normalizeYearValue(person.birthYear || '');
  const month = normalizeMonthDayValue(person.birthMonth || '');
  const day = normalizeMonthDayValue(person.birthDay || '');
  const hour = birthTimeUnknown
    ? (normalizeHourMinuteValue(person.birthHour || person.hour || hourRaw || '', 23) || UNKNOWN_BIRTH_TIME_FALLBACK.hour)
    : normalizeHourMinuteValue(person.birthHour || person.hour || hourRaw || '', 23);
  const minute = birthTimeUnknown
    ? (normalizeHourMinuteValue(person.birthMinute || person.minute || minuteRaw || '', 59) || UNKNOWN_BIRTH_TIME_FALLBACK.minute)
    : (normalizeHourMinuteValue(person.birthMinute || person.minute || minuteRaw || '', 59) || (hour ? '00' : ''));
  const apiBirthTime = birthTimeUnknown
    ? `${String(hour || UNKNOWN_BIRTH_TIME_FALLBACK.hour).padStart(2, '0')}:${String(minute || UNKNOWN_BIRTH_TIME_FALLBACK.minute).padStart(2, '0')}`
    : (normalizedBirthTime || (hour && minute ? `${hour}:${minute}` : ''));
  const calendar = person.calendarType === 'lunar' ? 'lunar' : 'solar';
  const calendarLabel = formatCalendarTypeForLucky(calendar);
  return {
    name: String(person.name || '').trim(),
    year,
    month,
    day,
    hour,
    minute,
    time: apiBirthTime,
    birthTime: apiBirthTime,
    displayBirthTime: birthTimeUnknown ? UNKNOWN_BIRTH_TIME_DISPLAY : (normalizedBirthTime || apiBirthTime || ''),
    birthTimeUnknown,
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
  const basePayload = { ...applicantPayload };
  return [
    {
      ...basePayload,
      targetDate,
      __periodMode: 'targetDate'
    },
    {
      ...basePayload,
      targetYear,
      targetMonth,
      __periodMode: 'targetYearMonth'
    }
  ];
}

function sanitizeApiErrorBodyForLog(text) {
  const raw = String(text || '').slice(0, 1200);
  const redactKeys = new Set(['name', 'birthYear', 'birthMonth', 'birthDay', 'birthHour', 'birthMinute', 'year', 'month', 'day', 'hour', 'minute', 'phone', 'email', 'person1', 'person2', 'note', 'concern']);
  const sanitizeValue = (value) => {
    if (Array.isArray(value)) return value.map(sanitizeValue);
    if (value && typeof value === 'object') {
      const out = {};
      for (const [key, nested] of Object.entries(value)) {
        out[key] = redactKeys.has(key) ? '[redacted]' : sanitizeValue(nested);
      }
      return out;
    }
    if (typeof value === 'string') {
      return value
        .replace(/\d{4}-\d{2}-\d{2}/g, '[redacted-date]')
        .replace(/\d{2}:\d{2}/g, '[redacted-time]')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
    }
    return value;
  };
  try {
    return JSON.stringify(sanitizeValue(JSON.parse(raw)));
  } catch {
    return raw
      .replace(/\d{4}-\d{2}-\d{2}/g, '[redacted-date]')
      .replace(/\d{2}:\d{2}/g, '[redacted-time]')
      .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
  }
}

function buildCompatibilityPayload(person1, person2, note = '') {
  const a = toLuckyFlatPayload(person1 || {});
  const b = toLuckyFlatPayload(person2 || {});
  const buildPersonPayload = (sourcePerson, flatPerson) => ({
    name: String(sourcePerson?.name || '').trim(),
    gender: flatPerson.gender,
    birthYear: flatPerson.birthYear,
    birthMonth: flatPerson.birthMonth,
    birthDay: flatPerson.birthDay,
    birthHour: flatPerson.birthHour || '',
    birthMinute: flatPerson.birthMinute || '00',
    year: flatPerson.year,
    month: flatPerson.month,
    day: flatPerson.day,
    hour: flatPerson.hour || '',
    minute: flatPerson.minute || '00',
    calendarType: flatPerson.calendarType,
    isLeapMonth: flatPerson.isLeapMonth === true
  });
  return {
    person1: buildPersonPayload(person1, a),
    person2: buildPersonPayload(person2, b),
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
  const sourcePillars = meta.selectedPillars || extractPillars(mansaeData, payload);
  const pillars = payload.birthTimeUnknown ? { ...sourcePillars, hour: '' } : sourcePillars;
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
      hour: payload.birthTimeUnknown ? payload.birthHour : (payload.birthTime ? String(payload.birthTime).split(':')[0] || '' : ''),
      minute: payload.birthTimeUnknown ? payload.birthMinute : (payload.birthTime ? String(payload.birthTime).split(':')[1] || '' : ''),
      calendar: payload.calendarType,
      gender: payload.gender,
      isLeapMonth: payload.isLeapMonth === true,
      birthTimeUnknown: payload.birthTimeUnknown === true,
      displayBirthTime: payload.birthTimeUnknown ? UNKNOWN_BIRTH_TIME_DISPLAY : (payload.birthTime || '')
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
    distributionMeta: source === 'lucky'
      ? {
          mode: 'api-composite',
          panelNote: '지장간 포함 기준으로 계산된 종합 비율입니다.',
          elementHint: '겉으로 토가 없어 보여도 지지 속 지장간에 토 기운이 있으면 오행 분포에 반영될 수 있어요.'
        }
      : {
          mode: 'fallback-reference',
          panelNote: '현재 화면은 대체 분포 기준으로 정리한 참고 비율입니다.',
          elementHint: '실제 Lucky API 종합 분포와는 차이가 있을 수 있습니다.'
        },
    summary: `${name}님은 기본적으로 ${dominantElement} 기운이 또렷하고 ${dominantGod} 성향이 전면에 드러나는 흐름으로 읽힙니다.`,
    trait: `${name}님은 자신의 판단 기준이 분명한 편이며, 한번 방향을 정하면 끝까지 밀어붙이는 힘이 있습니다. 다만 피로가 쌓일 때는 감정 기복이 커질 수 있어 템포 조절이 중요합니다.`,
    love: `관계에서는 솔직함과 안정감을 동시에 원합니다. 가까워질수록 속도를 맞춰주는 사람이 잘 맞고, 말보다 행동에서 신뢰를 확인하려는 경향이 있습니다.`,
    work: `일과 재물에서는 당장의 성과보다 흐름을 길게 보는 편이 유리합니다. 익숙한 영역에서 실력을 쌓되, 결정적인 시점에는 스스로 주도권을 잡는 방식이 좋습니다.`,
    ui: {
      sourceLabel: source === 'lucky' ? 'Lucky API' : source === 'mock' ? 'MOCK DATA' : 'LOCAL FALLBACK',
      intro: payload.birthTimeUnknown
        ? '출생시간이 확인되지 않아 시주를 제외한 생년월일 중심으로 사주 원국과 핵심 해석을 정리했습니다.'
        : '입력한 생년월일시를 바탕으로 사주 원국, 오행/십성 경향, 핵심 해석을 한 화면에 정리했습니다.',
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
  const birthTimeUnknown = payload?.birthTimeUnknown === true || payload?.birthTimeUnknown === 'true';
  const requiredPillars = birthTimeUnknown ? ['year', 'month', 'day'] : ['year', 'month', 'day', 'hour'];
  const missing = requiredPillars.filter((key) => !pillarDebug?.pillars?.[key]);
  if (missing.length) {
    console.log(`[SAJU VALIDATION] missing birth pillars detected: ${missing.join(', ')}`);
    throw createStructuredSummaryError(`Lucky API에서 출생 ${missing.map(localizePillarName).join('/')} 필드를 찾지 못했습니다.`, {
      source: 'lucky',
      usingFallback: false,
      selectedPillarsFrom: pillarDebugToResponsePaths(pillarDebug)
    });
  }
  if (birthTimeUnknown && !pillarDebug?.pillars?.hour) {
    console.log('[SAJU VALIDATION] hour pillar missing but allowed because birth time is unknown');
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
  if (birthTimeUnknown) return;
  const hourBranch = normalizeBranchChar((pillarDebug.pillars.hour || '').slice(1));
  const expectedHourBranch = guessExpectedHourBranch(payload.birthTime || '');
  if (hourBranch && expectedHourBranch && hourBranch !== expectedHourBranch) {
    console.log(`[SAJU VALIDATION] hour branch mismatch detected: input=${payload.birthTime || ''}, expected=${expectedHourBranch}, actual=${hourBranch}`);
    console.log('[SAJU VALIDATION] hour branch mismatch detail', JSON.stringify({
      inputBirthTime: payload.birthTime || '',
      inputHour: String(payload.birthTime || '').split(':')[0] || '',
      inputMinute: String(payload.birthTime || '').split(':')[1] || '',
      expectedHourBranch,
      actualHourBranch: hourBranch,
      selectedHourPath: pillarDebug?.selectedPaths?.hour || '',
      selectedHourPillar: pillarDebug?.pillars?.hour || ''
    }));
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
      if (guessedType && directPillar && !pathHasExcludedToken(childPath)) {
        candidates.push({
          type: guessedType,
          path: childPath,
          value: directPillar,
          score: scoreCandidatePath(childPath, 'direct'),
          reason: 'direct-value'
        });
      }
      if (value && typeof value === 'object' && !pathHasExcludedToken(childPath)) {
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
  return containsAnyToken(path, [
    'daeun', 'seun', 'period', 'fortune', 'future', 'default', 'baseyear', 'basemonth', 'baseday', 'today', 'daily', 'current',
    '월운', '세운', '대운', '일진', '시운', '기간', '운세',
    'sipseong', 'tengod', 'tengods', 'ohaeng', 'eumyang', 'hiddenstem', 'hiddenstems', 'relation', 'deity', 'strength'
  ]);
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

function buildRequiredAiSections(hasCompatibility) {
  const sections = [
    '핵심 요약','사주 원국 해석','대운','세운','월운','운성','신살,귀인','십성','재물운','직업운','애정운','자녀운','건강운','실천 조언','주의할 점','고민에 대한 조언'
  ];
  if (hasCompatibility) sections.push('관계/궁합 해석');
  return sections;
}

function searchLooseValue(root, tokenGroups = []) {
  const groups = tokenGroups.map((group) => Array.isArray(group) ? group : [group]).filter(Boolean);
  const queue = [root];
  let scanned = 0;
  while (queue.length && scanned < 3000) {
    const current = queue.shift();
    scanned += 1;
    if (!current || typeof current !== 'object') continue;
    const entries = Array.isArray(current) ? current.map((value, index) => [String(index), value]) : Object.entries(current);
    for (const [key, value] of entries) {
      const lower = String(key || '').toLowerCase();
      if (groups.some((group) => group.every((token) => lower.includes(String(token).toLowerCase())))) return value;
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return null;
}

function summarizeLooseValue(value, limit = 8) {
  if (value == null) return null;
  if (typeof value === 'string') return value.trim().slice(0, 1200);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, limit).map((item) => summarizeLooseValue(item, 4));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, nested] of Object.entries(value).slice(0, limit)) {
      out[key] = summarizeLooseValue(nested, 4);
    }
    return out;
  }
  return String(value).slice(0, 400);
}

function extractPeriodRows(periodRaw, mode = 'year') {
  const rows = [];
  const queue = [periodRaw];
  let scanned = 0;
  while (queue.length && scanned < 4000 && rows.length < 12) {
    const current = queue.shift();
    scanned += 1;
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      current.forEach((item) => queue.push(item));
      continue;
    }
    const keys = Object.keys(current);
    const lowerKeys = keys.map((key) => key.toLowerCase());
    const hasYear = lowerKeys.some((key) => key.includes('year') || key.includes('연'));
    const hasMonth = lowerKeys.some((key) => key.includes('month') || key.includes('월'));
    const hasScore = lowerKeys.some((key) => key.includes('score') || key.includes('point') || key.includes('운세') || key.includes('summary') || key.includes('요약'));
    const valid = mode === 'month' ? hasYear && hasMonth : hasYear;
    if (valid && hasScore) {
      const row = {
        year: String(findLooseValue(current, ['year','연도']) || findLooseValue(current, ['year']) || '').trim(),
        month: String(findLooseValue(current, ['month','월']) || findLooseValue(current, ['month']) || '').trim(),
        score: String(findLooseValue(current, ['score']) || findLooseValue(current, ['point']) || '').trim(),
        ganji: String(findLooseValue(current, ['ganji']) || findLooseValue(current, ['간지']) || findLooseValue(current, ['label']) || '').trim(),
        summary: String(findLooseValue(current, ['summary']) || findLooseValue(current, ['요약']) || findLooseValue(current, ['comment']) || findLooseValue(current, ['desc']) || '').trim()
      };
      if (row.year || row.summary || row.ganji || row.score) rows.push(row);
    }
    for (const value of Object.values(current)) {
      if (value && typeof value === 'object') queue.push(value);
    }
  }
  return rows.slice(0, mode === 'month' ? 6 : 5);
}

function collectPromptContext(order, apiSnapshots, warnings) {
  const apiBase = apiSnapshots.saju || apiSnapshots.mansae || {};
  const rawPillars = extractPillars(apiBase, order.applicant);
  const birthTimeUnknown = order.applicant?.birthTimeUnknown === true;
  const pillars = birthTimeUnknown ? { ...rawPillars, hour: '' } : rawPillars;
  const pillarDetails = buildPillarDetails(pillars, apiBase);
  const fiveElements = extractDistribution(apiBase, ['오행', 'five', 'element']) || {};
  const tenGods = extractDistribution(apiBase, ['십성', 'tenGod', 'ten']) || {};
  const hasCompatibility = Boolean(apiSnapshots.compatibility && order.partner?.name);
  return {
    basicInfo: {
      name: order.applicant?.name || '',
      gender: order.applicant?.gender || '',
      birthYear: order.applicant?.birthYear || '',
      birthMonth: order.applicant?.birthMonth || '',
      birthDay: order.applicant?.birthDay || '',
      birthTime: order.applicant?.birthTime || '',
      birthTimeUnknown,
      displayBirthTime: birthTimeUnknown ? UNKNOWN_BIRTH_TIME_DISPLAY : (order.applicant?.birthTime || ''),
      calendarType: formatCalendarTypeForLucky(order.applicant?.calendarType || 'solar'),
      isLeapMonth: order.applicant?.isLeapMonth === true,
      baselineDate: `${CONFIG.lucky.defaultPeriodYear}-${String(CONFIG.lucky.defaultPeriodMonth).padStart(2, '0')}-${String(CONFIG.lucky.defaultPeriodDay).padStart(2, '0')}`,
      concern: order.applicant?.concern || ''
    },
    partnerInfo: order.partner ? {
      name: stripHonorificSuffix(order.partner?.name || ''),
      gender: order.partner?.gender || '',
      birthYear: order.partner?.birthYear || '',
      birthMonth: order.partner?.birthMonth || '',
      birthDay: order.partner?.birthDay || '',
      birthTime: order.partner?.birthTime || '',
      birthTimeUnknown: order.partner?.birthTimeUnknown === true,
      displayBirthTime: order.partner?.birthTimeUnknown === true ? UNKNOWN_BIRTH_TIME_DISPLAY : (order.partner?.birthTime || ''),
      calendarType: formatCalendarTypeForLucky(order.partner?.calendarType || 'solar'),
      isLeapMonth: order.partner?.isLeapMonth === true,
      memo: order.partner?.memo || ''
    } : null,
    pillars,
    pillarDetails,
    fiveElements,
    tenGods,
    gyeokguk: summarizeLooseValue(searchLooseValue(apiSnapshots.saju, [['격국'], ['gyeok'], ['格局']]), 10),
    strength: summarizeLooseValue(searchLooseValue(apiSnapshots.saju, [['신강'], ['신약'], ['strength'], ['강약']]), 10),
    yongsin: summarizeLooseValue(searchLooseValue(apiSnapshots.saju, [['용신'], ['희신'], ['기신'], ['yong']]), 10),
    johu: summarizeLooseValue(searchLooseValue(apiSnapshots.saju, [['조후'], ['johu'], ['조화']]), 10),
    daeun: summarizeLooseValue(searchLooseValue(apiSnapshots.saju, [['daeun'], ['대운']]), 12),
    futureFiveYears: extractPeriodRows(apiSnapshots.period, 'year'),
    futureSixMonths: extractPeriodRows(apiSnapshots.period, 'month'),
    compatibility: summarizeLooseValue(apiSnapshots.compatibility, 14),
    internalWarnings: Array.isArray(warnings) ? warnings.slice(0, 8) : [],
    hasCompatibility
  };
}

function buildAiPromptPayload(order, apiSnapshots, warnings) {
  const promptContext = collectPromptContext(order, apiSnapshots, warnings);
  return {
    basicInfo: promptContext.basicInfo,
    partnerInfo: promptContext.partnerInfo,
    analysisNotes: {
      birthTimeUnknown: promptContext.basicInfo?.birthTimeUnknown === true,
      note: promptContext.basicInfo?.birthTimeUnknown === true
        ? '사용자가 출생시간을 모르는 상태입니다. 따라서 시주를 확정하지 말고, 생년월일 중심으로 해석하세요. 시주 기반의 세부 해석, 자녀운, 말년운, 시간대에 민감한 신살 해석은 단정하지 말고 보수적으로 작성하세요.'
        : ''
    },
    chartData: {
      pillars: promptContext.pillars,
      pillarDetails: promptContext.pillarDetails,
      fiveElements: promptContext.fiveElements,
      tenGods: promptContext.tenGods,
      gyeokguk: promptContext.gyeokguk,
      strength: promptContext.strength,
      yongsin: promptContext.yongsin,
      johu: promptContext.johu,
      daeun: promptContext.daeun,
      futureFiveYears: promptContext.futureFiveYears,
      futureSixMonths: promptContext.futureSixMonths,
      compatibility: promptContext.compatibility
    },
    rawBundle: {
      mansae: apiSnapshots.mansae || null,
      saju: apiSnapshots.saju || null,
      period: apiSnapshots.period || null,
      compatibility: apiSnapshots.compatibility || null
    },
    internalReference: {
      consistencyWarnings: promptContext.internalWarnings,
      compatibilityRequested: Boolean(order.compatibilityRequested),
      requiredSections: buildRequiredAiSections(promptContext.hasCompatibility)
    }
  };
}

function cleanSectionText(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeSectionKeyAlias(section = '') {
  const normalized = String(section || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*[·•ㆍ]\s*/g, '·')
    .replace(/\s*,\s*/g, ',');
  if (normalized === '신살·귀인' || normalized === '신살, 귀인' || normalized === '신살,귀인') return '신살,귀인';
  if (normalized === '궁합 참고 해석') return '관계/궁합 해석';
  return normalized;
}

function splitParagraphs(text) {
  return cleanSectionText(text).split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
}

function countMeaningfulParagraphs(text) {
  return splitParagraphs(text).length;
}

function countVisibleChars(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

function collectConcernKeywords(concern) {
  const stop = new Set(['현재','고민','또는','상담받고','싶은','내용','궁금해요','궁금합니다','잘','될까요','어떻게','준비중인데','준비중','그리고','대한','관련','온라인']);
  return Array.from(new Set(String(concern || '')
    .replace(/[^0-9A-Za-z가-힣\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stop.has(token)))).slice(0, 8);
}

function extractBalancedJsonCandidate(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  const first = source.indexOf('{');
  if (first < 0) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = first; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(first, index + 1);
    }
  }
  return '';
}

function tryParseJsonText(text) {
  if (text == null) return null;
  const raw = String(text).trim();
  if (!raw) return null;
  const candidates = [raw, stripCodeFences(raw), extractBalancedJsonCandidate(stripCodeFences(raw))].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next candidate
    }
  }
  return null;
}

function sanitizeKiePreviewText(text, limit = 500) {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted-key]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]')
    .replace(/"(name|birthYear|birthMonth|birthDay|birthHour|birthMinute|year|month|day|hour|minute|phone|email|concern|note|memo|birthTime)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .slice(0, limit);
}

function normalizeKieStringValue(value) {
  if (typeof value === 'string') return cleanSectionText(value);
  if (value == null) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return cleanSectionText(JSON.stringify(value));
}

function extractTextFromMessageContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.text && typeof part.text === 'string') return part.text;
    if (part?.output_text && typeof part.output_text === 'string') return part.output_text;
    if (typeof part?.content === 'string') return part.content;
    if (Array.isArray(part?.content)) return extractTextFromMessageContent(part.content);
    return '';
  }).filter(Boolean).join('\n');
}

function hasLikelySectionKeys(obj, requiredSections) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj).map((key) => normalizeSectionKeyAlias(key));
  return requiredSections.some((section) => keys.includes(normalizeSectionKeyAlias(section)));
}

function normalizeAiSections(rawSections, requiredSections) {
  if (!rawSections || typeof rawSections !== 'object' || Array.isArray(rawSections)) return null;
  const normalized = {};
  for (const [key, value] of Object.entries(rawSections)) {
    const normalizedKey = normalizeSectionKeyAlias(key);
    normalized[normalizedKey] = normalizeKieStringValue(value);
  }
  const output = {};
  requiredSections.forEach((key) => {
    const normalizedKey = normalizeSectionKeyAlias(key);
    output[key] = typeof normalized[normalizedKey] === 'string' ? cleanSectionText(normalized[normalizedKey]) : '';
  });
  return output;
}

const SECTION_INTRO_MAP = {
  '핵심 요약': '핵심 요약은 사주 전반의 흐름과 현재 가장 먼저 짚어야 할 포인트를 짧게 정리해 보는 항목입니다.',
  '사주 원국 해석': '사주 원국 해석은 타고난 기질과 기본 성향, 삶의 중심 패턴을 살펴보는 항목입니다.',
  '대운': '대운은 인생의 큰 흐름과 장기적인 변화 방향을 살펴보는 항목입니다.',
  '세운': '세운은 특정 해에 들어오는 분위기와 선택의 흐름을 살펴보는 항목입니다.',
  '월운': '월운은 특정 달에 나타나기 쉬운 흐름과 컨디션, 주의할 점을 살펴보는 항목입니다.',
  '운성': '운성은 시기별 에너지의 움직임과 삶의 리듬 변화를 살펴보는 항목입니다.',
  '신살,귀인': '신살과 귀인은 주변 환경의 변수와 도움을 주는 인연의 흐름을 살펴보는 항목입니다.',
  '십성': '십성은 사람을 대하는 방식과 일의 태도, 관계 속 역할 성향을 살펴보는 항목입니다.',
  '재물운': '재물운은 돈을 벌고 관리하는 방식, 소비와 투자 성향, 재정적 기회를 살펴보는 항목입니다.',
  '직업운': '직업운은 일하는 방식, 적성, 커리어 방향, 조직과의 관계를 살펴보는 항목입니다.',
  '애정운': '애정운은 감정 표현 방식과 관계의 안정감, 가까운 사람과의 호흡을 살펴보는 항목입니다.',
  '자녀운': '자녀운은 돌봄의 태도와 책임감, 가족 안에서의 양육 흐름을 살펴보는 항목입니다.',
  '건강운': '건강운은 체력 소모 패턴과 컨디션 관리 포인트, 생활 리듬을 살펴보는 항목입니다.',
  '실천 조언': '실천 조언은 지금 흐름에서 바로 적용해 볼 수 있는 행동 기준과 생활 팁을 정리하는 항목입니다.',
  '주의할 점': '주의할 점은 현재 흐름에서 무리하거나 놓치기 쉬운 부분을 미리 점검하는 항목입니다.',
  '고민에 대한 조언': '고민에 대한 조언은 현재 질문과 가장 직접적으로 연결되는 선택 기준과 실천 방향을 살펴보는 항목입니다.',
  '관계/궁합 해석': '관계/궁합 해석은 두 사람의 기질 차이와 소통 방식, 갈등 조율 포인트를 살펴보는 항목입니다.'
};

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function prependSectionIntro(section, text) {
  const body = String(text || '').trim();
  if (!body) return body;
  const intro = SECTION_INTRO_MAP[section] || '';
  if (!intro) return body;
  const firstChunk = body.slice(0, 180);
  if (firstChunk.includes(intro) || /항목입니다|살펴보는 항목|정리하는 항목|의미하는 항목/.test(firstChunk)) return body;
  return `${intro}\n\n${body}`;
}


function stripHonorificSuffix(name) {
  return String(name || '').replace(/\s+/g, ' ').trim().replace(/\s*님+$/g, '').trim();
}

function formatHonorificName(name) {
  const base = stripHonorificSuffix(name);
  return base ? `${base}님` : '';
}

function fixHonorifics(text) {
  return cleanSectionText(String(text || '')
    .replace(/([가-힣A-Za-z0-9]+)님[ \t]+님/g, '$1님')
    .replace(/([가-힣A-Za-z0-9]+)[ \t]+님/g, '$1님')
    .replace(/님님+/g, '님')
    .replace(/님[ \t]+(?=(은|는|이|가|을|를|의|과|와|도|만|께서|께|에게|한테|처럼|보다|부터|까지|랑|으로|로|에|이나|나|이며|인데|입니다|입니까|일|적))/g, '님')
    .replace(/[ \t]{2,}/g, ' '));
}

function normalizeHonorificSpacing(text) {
  return fixHonorifics(text);
}

function applyHonorificsToText(text, names = []) {
  let output = normalizeHonorificSpacing(text);
  const filteredNames = Array.from(new Set((Array.isArray(names) ? names : [])
    .map((item) => stripHonorificSuffix(item))
    .filter(Boolean)))
    .sort((a, b) => b.length - a.length);
  for (const name of filteredNames) {
    const escaped = escapeRegex(name);
    const honorific = `${name}님`;
    output = output.replace(new RegExp(`${escaped}\\s*님\\s*님+`, 'g'), honorific);
    const particlePattern = new RegExp(`(^|[^가-힣A-Za-z0-9])(${escaped})(?!\\s*님)(?=(은|는|이|가|을|를|의|과|와|도|만|께서|께|에게|한테|처럼|보다|부터|까지|랑|으로|로|에|이나|나|이며|인데|입니다|입니까|일|적|\\s|[.,!?;:()"'“”‘’]|$))`, 'g');
    output = output.replace(particlePattern, (match, prefix, found) => `${prefix}${found}님`);
    const barePattern = new RegExp(`(^|[^가-힣A-Za-z0-9])(${escaped})(?!\\s*님)(?=\\s|[.,!?;:()"'“”‘’]|$)`, 'g');
    output = output.replace(barePattern, (match, prefix, found) => `${prefix}${found}님`);
  }
  return normalizeHonorificSpacing(output);
}

function splitReportSentences(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split(/(?<=[.!?]|다\.|요\.)\s+/)
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

const TERM_EXPLANATION_MAP = {
  '편관격': '쉽게 말하면 책임과 압박이 오히려 추진력으로 바뀌기 쉬운 구조입니다',
  '신약': '쉽게 말하면 에너지가 쉽게 소모되어 주변 환경의 영향을 민감하게 받기 쉬운 상태입니다',
  '용신': '쉽게 말하면 사주의 균형을 잡아주는 핵심 요소입니다',
  '희신': '쉽게 말하면 용신을 도와 흐름을 부드럽게 만드는 보조 요소입니다',
  '재성': '쉽게 말하면 돈, 현실 감각, 결과물을 다루는 힘입니다',
  '관성': '쉽게 말하면 책임, 규칙, 직장과 사회적 역할을 다루는 힘입니다',
  '비겁': '쉽게 말하면 나와 비슷한 기질, 자존감, 경쟁심, 동료 에너지를 뜻합니다'
};

const SECTION_PERSPECTIVE_GUIDE = {
  '핵심 요약': '핵심 요약에서는 전체 분위기와 지금 가장 먼저 붙잡아야 할 우선순위를 요약합니다.',
  '사주 원국 해석': '사주 원국 해석에서는 타고난 기질과 기본 성향, 반복되기 쉬운 반응 패턴을 설명합니다.',
  '대운': '대운에서는 10년 안팎의 장기 흐름, 인생 방향 전환, 기반 형성 여부를 중심으로 설명합니다.',
  '세운': '세운에서는 해당 연도의 상반기와 하반기, 또는 일·돈·관계·건강의 연간 포인트를 중심으로 설명합니다.',
  '월운': '월운에서는 이번 달에 바로 적용할 수 있는 일정 관리, 감정 관리, 관계 조율 같은 실천 포인트를 중심으로 설명합니다.',
  '운성': '운성에서는 에너지의 리듬과 속도 조절, 회복과 확장의 균형을 설명합니다.',
  '신살,귀인': '신살과 귀인에서는 사람과 환경 변수, 도움을 주는 인연, 조심해야 할 상황을 설명합니다.',
  '십성': '십성에서는 관계에서 맡기 쉬운 역할과 일 처리 방식, 심리적 반응 습관을 설명합니다.',
  '재물운': '재물운에서는 수입보다도 관리 습관, 소비 기준, 위험 관리 방식에 초점을 맞춥니다.',
  '직업운': '직업운에서는 일하는 방식, 조직 적응, 역할 선택, 커리어 방향성을 설명합니다.',
  '애정운': '애정운에서는 감정 표현과 안정감, 관계 유지 방식, 현실적인 만남 기준을 설명합니다.',
  '자녀운': '자녀운에서는 돌봄 태도, 책임감, 가족 안에서의 역할과 양육 관점을 설명합니다.',
  '건강운': '건강운에서는 생활 리듬, 피로 누적 패턴, 회복 습관과 컨디션 관리 포인트를 설명합니다.',
  '실천 조언': '실천 조언에서는 당장 적용 가능한 행동 기준과 생활 루틴을 구체적으로 제안합니다.',
  '주의할 점': '주의할 점에서는 실수하기 쉬운 패턴과 결정 전에 다시 확인해야 할 부분을 설명합니다.',
  '고민에 대한 조언': '고민에 대한 조언에서는 사용자의 질문에 직접 연결되는 현실적인 선택 기준을 제시합니다.',
  '관계/궁합 해석': '관계/궁합 해석에서는 두 사람의 차이를 어떻게 조율하면 좋은지에 초점을 맞춥니다.'
};

const REPEAT_NORMALIZATION_PATTERNS = [
  [/신약\s*[,은는이가을를의]*/g, '신약'],
  [/편관격\s*[,은는이가을를의]*/g, '편관격'],
  [/용신\s*금/g, '용신금'],
  [/희신\s*토/g, '희신토'],
  [/혼자\s*감당하지\s*말[^.!?]*[.!?]?/g, '혼자 감당하지 말 것'],
  [/무리한\s*투자\s*주의[^.!?]*[.!?]?/g, '무리한 투자 주의']
];

function buildRepeatKey(sentence) {
  const normalized = String(sentence || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  let key = normalized;
  for (const [pattern, replacement] of REPEAT_NORMALIZATION_PATTERNS) {
    key = key.replace(pattern, replacement);
  }
  return key.replace(/["'“”‘’.,!?;:()\-]/g, '').trim();
}

function annotateJargonFirstUse(text, explainedTerms = new Set()) {
  let output = String(text || '');
  for (const [term, explanation] of Object.entries(TERM_EXPLANATION_MAP)) {
    if (explainedTerms.has(term)) continue;
    const pattern = new RegExp(`${escapeRegex(term)}(?!\\s*\\(|[^\\n]{0,40}쉽게\\s*말하면)`, '');
    if (!pattern.test(output)) continue;
    output = output.replace(pattern, `${term}(${explanation})`);
    explainedTerms.add(term);
  }
  return output;
}

function splitLongParagraphsForMobile(text) {
  const paragraphs = String(text || '').split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const rebuilt = [];
  for (const paragraph of paragraphs) {
    const sentences = splitReportSentences(paragraph);
    if (sentences.length <= 4) {
      rebuilt.push(paragraph);
      continue;
    }
    for (let index = 0; index < sentences.length; index += 3) {
      rebuilt.push(sentences.slice(index, index + 3).join(' ').trim());
    }
  }
  return rebuilt.join('\n\n').trim();
}

function removeRepeatedSentencesFromText(text, seenSentences = new Map()) {
  const paragraphs = String(text || '').split(/\n{2,}/).map((item) => item.trim()).filter(Boolean);
  const rebuilt = [];
  for (const paragraph of paragraphs) {
    const kept = [];
    for (const sentence of splitReportSentences(paragraph)) {
      const normalized = sentence.replace(/\s+/g, ' ').trim();
      const repeatKey = buildRepeatKey(normalized);
      if ((normalized.length >= 25 || repeatKey) && repeatKey && (seenSentences.get(repeatKey) || 0) >= 1) continue;
      kept.push(sentence);
      if (repeatKey) seenSentences.set(repeatKey, (seenSentences.get(repeatKey) || 0) + 1);
    }
    if (kept.length) rebuilt.push(kept.join(' ').trim());
  }
  return rebuilt.join('\n\n').trim();
}

const SECTION_SUMMARY_MAP = {
  '핵심 요약': '정리하면, 지금은 전체 흐름을 한 번에 바꾸기보다 우선순위를 정하고 차분히 밀어가는 태도가 중요합니다.',
  '사주 원국 해석': '정리하면, 타고난 성향을 억지로 바꾸기보다 강점을 살리고 약한 부분을 생활 습관으로 보완하는 방식이 잘 맞습니다.',
  '대운': '정리하면, 대운은 단기 성과보다 몇 년 단위 방향과 기반 정비를 먼저 보는 것이 중요합니다.',
  '세운': '정리하면, 세운은 올해의 선택 우선순위를 분명히 하고 일·돈·관계의 균형을 맞추는 데 초점을 두는 것이 좋습니다.',
  '월운': '정리하면, 월운은 이번 달 바로 실천할 수 있는 한두 가지를 꾸준히 지키는 것이 핵심입니다.',
  '운성': '정리하면, 운성은 속도를 올리는 시기와 숨을 고르는 시기를 구분해 리듬을 맞추는 것이 중요합니다.',
  '신살,귀인': '정리하면, 사람과 기회가 들어오는 흐름일수록 조건 확인과 기록 습관이 더 중요합니다.',
  '십성': '정리하면, 십성 해석은 성향을 고정적으로 단정하기보다 관계와 일에서 어떤 역할을 편하게 수행하는지 이해하는 데 도움이 됩니다.',
  '재물운': '정리하면, 재물운은 큰 한 방보다 새는 지출을 줄이고 지속 가능한 관리 기준을 세우는 쪽이 유리합니다.',
  '직업운': '정리하면, 직업운은 겉으로 좋아 보이는 자리보다 실제 역할과 성장 가능성을 먼저 보는 것이 좋습니다.',
  '애정운': '정리하면, 애정운은 설렘보다 생활 리듬과 약속을 지키는 안정감이 오래 가는 관계를 만듭니다.',
  '자녀운': '정리하면, 자녀운은 책임감과 애정을 균형 있게 쓰되 통제보다 대화 중심으로 풀어가는 태도가 중요합니다.',
  '건강운': '정리하면, 건강운은 버티는 힘보다 회복 리듬을 만드는 생활 관리가 더 중요합니다.',
  '실천 조언': '정리하면, 실천 조언은 계획을 많이 세우는 것보다 지금 바로 지속할 수 있는 작은 행동을 정하는 데 의미가 있습니다.',
  '주의할 점': '정리하면, 주의할 점은 조급함으로 결정을 앞당기지 말고 확인과 정리를 한 번 더 거치는 습관을 들이는 것입니다.',
  '고민에 대한 조언': '정리하면, 현재 고민은 운의 좋고 나쁨보다 무엇을 먼저 정리하고 어디에 힘을 모을지 결정하는 과정이 더 중요합니다.',
  '관계/궁합 해석': '정리하면, 관계/궁합 해석은 좋고 나쁨의 판정보다 서로의 차이를 어떻게 조율할지에 초점을 맞춰 보는 것이 좋습니다.'
};

function appendSectionSummary(section, text) {
  const output = String(text || '').trim();
  if (!output) return output;
  if (/정리하면[,:]?/.test(output)) return output;
  const summary = SECTION_SUMMARY_MAP[section] || '정리하면, 현재 흐름은 무리하게 단정하기보다 생활 속에서 조절하고 실천하는 방식으로 풀어가는 것이 좋습니다.';
  return `${output}\n\n${summary}`.trim();
}

function appendHealthDisclaimer(text) {
  const output = String(text || '').trim();
  if (!output) return output;
  const disclaimer = '건강운은 의학적 진단이 아니라 생활 습관을 점검하기 위한 참고용 해석입니다. 불편한 증상이 있다면 전문의 상담을 권장드립니다.';
  if (output.includes(disclaimer)) return output;
  return `${output}\n\n${disclaimer}`.trim();
}

function stripCustomerFacingArtifacts(text) {
  let output = String(text || '');
  output = output.replace(/[^\n.!?]*(downloadUrl|pdfPath|pdf|debug)[^\n.!?]*(?:[.!?]|$)/gi, ' ');
  return cleanSectionText(output);
}

function normalizeFormalKoreanStyle(text) {
  let output = String(text || '').trim();
  if (!output) return output;
  const replacements = [
    [/좋다\./g, '좋습니다.'],
    [/필요하다\./g, '필요합니다.'],
    [/중요하다\./g, '중요합니다.'],
    [/유리하다\./g, '유리합니다.'],
    [/불리하다\./g, '불리합니다.'],
    [/가능하다\./g, '가능합니다.'],
    [/이어진다\./g, '이어집니다.'],
    [/보인다\./g, '보입니다.'],
    [/작용한다\./g, '작용합니다.'],
    [/생긴다\./g, '생길 수 있습니다.'],
    [/커진다\./g, '커질 수 있습니다.'],
    [/된다\./g, '됩니다.'],
    [/맞다\./g, '맞습니다.'],
    [/권한다\./g, '권합니다.'],
    [/좋아진다\./g, '좋아질 수 있습니다.'],
    [/일어난다\./g, '일어날 수 있습니다.'],
    [/늘어난다\./g, '늘어날 수 있습니다.'],
    [/줄어든다\./g, '줄어들 수 있습니다.']
  ];
  for (const [pattern, replacement] of replacements) output = output.replace(pattern, replacement);
  return output;
}

function convertMonthlySectionToFormalStyle(text) {
  let output = normalizeFormalKoreanStyle(text);
  if (!output) return output;
  const replacements = [
    [/감정 기복이 커진다/g, '감정 기복이 커질 수 있습니다'],
    [/오해가 생긴다/g, '오해가 생길 수 있습니다'],
    [/지출 관리가 필요하다/g, '지출 관리가 필요합니다']
  ];
  for (const [pattern, replacement] of replacements) output = output.replace(pattern, replacement);
  return output;
}

function ensureSectionPerspective(section, text) {
  const output = String(text || '').trim();
  if (!output) return output;
  const hint = SECTION_PERSPECTIVE_GUIDE[section] || '';
  const firstParagraph = output.split(/\n{2,}/)[0] || '';
  if (!hint || firstParagraph.includes(hint)) return output;
  if (/무엇을 의미|살펴보는 항목|중심으로 설명합니다|초점을 맞춥니다/.test(firstParagraph)) return output;
  return `${hint}\n\n${output}`.trim();
}

function postProcessReportSections(promptPayload, sections) {
  const inputNames = [promptPayload?.basicInfo?.name, promptPayload?.applicant?.name, promptPayload?.partnerInfo?.name, promptPayload?.partner?.name]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  const explainedTerms = new Set();
  const seenSentences = new Map();
  const output = {};
  for (const [section, rawText] of Object.entries(sections || {})) {
    const normalizedSection = normalizeSectionKeyAlias(section);
    let nextText = cleanSectionText(rawText);
    if (!nextText) {
      output[normalizedSection] = '';
      continue;
    }
    nextText = stripCustomerFacingArtifacts(nextText);
    nextText = prependSectionIntro(normalizedSection, nextText);
    nextText = ensureSectionPerspective(normalizedSection, nextText);
    nextText = annotateJargonFirstUse(nextText, explainedTerms);
    nextText = normalizeFormalKoreanStyle(nextText);
    if (normalizedSection === '월운') nextText = convertMonthlySectionToFormalStyle(nextText);
    nextText = applyHonorificsToText(nextText, inputNames);
    nextText = removeRepeatedSentencesFromText(nextText, seenSentences);
    nextText = splitLongParagraphsForMobile(nextText);
    nextText = appendSectionSummary(normalizedSection, nextText);
    if (normalizedSection === '건강운') nextText = appendHealthDisclaimer(nextText);
    nextText = fixHonorifics(nextText);
    output[normalizedSection] = cleanSectionText(nextText);
  }
  return output;
}


function collectSectionObjectCandidates(parsed, requiredSections) {
  const candidates = [];
  const pushCandidate = (label, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    candidates.push({ label, value });
  };
  pushCandidate('root', parsed);
  pushCandidate('root.sections', parsed?.sections);
  pushCandidate('root.data.sections', parsed?.data?.sections);
  pushCandidate('root.result.sections', parsed?.result?.sections);
  pushCandidate('root.data', parsed?.data);
  pushCandidate('root.result', parsed?.result);
  return candidates.filter((item) => hasLikelySectionKeys(item.value, requiredSections));
}

function extractNestedJsonStringCandidates(parsed) {
  const values = [];
  const pushValue = (label, value) => {
    if (typeof value === 'string' && value.trim()) values.push({ label, value: value.trim() });
  };
  pushValue('output_text', parsed?.output_text);
  pushValue('output[0].content[0].text', parsed?.output?.[0]?.content?.[0]?.text);
  pushValue('output[0].content[0].output_text', parsed?.output?.[0]?.content?.[0]?.output_text);
  pushValue('choices[0].message.content', extractTextFromMessageContent(parsed?.choices?.[0]?.message?.content));
  pushValue('data.text', parsed?.data?.text);
  pushValue('text', parsed?.text);
  pushValue('content', parsed?.content);
  pushValue('result', typeof parsed?.result === 'string' ? parsed.result : '');
  pushValue('message', typeof parsed?.message === 'string' ? parsed.message : '');
  return values.filter((item) => item.value);
}

function normalizeSectionHeading(label) {
  return normalizeSectionKeyAlias(String(label || '').replace(/^#+\s*/, ''));
}

function parseTextTitleSections(raw, requiredSections) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  const headingMap = new Map();
  requiredSections.forEach((title) => {
    headingMap.set(normalizeSectionHeading(title), title);
    if (title === '신살,귀인') headingMap.set('신살, 귀인', title);
  });
  const sections = Object.fromEntries(requiredSections.map((title) => [title, '']));
  let current = '';
  for (const line of lines) {
    const normalizedHeading = normalizeSectionHeading(line);
    if (headingMap.has(normalizedHeading)) {
      current = headingMap.get(normalizedHeading) || '';
      continue;
    }
    if (!current) continue;
    sections[current] = `${sections[current]}${sections[current] ? '\n' : ''}${line}`.trim();
  }
  return Object.values(sections).some(Boolean) ? sections : null;
}

function detectKieResponseFormat(raw, parsed, requiredSections) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return 'empty';
  if (/^```/m.test(trimmed)) return 'markdown';
  if (/^##\s+/m.test(trimmed)) return 'text_titles';
  if (hasLikelySectionKeys(parsed, requiredSections)) return 'json';
  if (parsed?.sections || parsed?.data?.sections || parsed?.result?.sections) return 'json';
  if (parsed && typeof parsed === 'object') return 'json_wrapper';
  if (/server exception|try again later|error/i.test(trimmed)) return 'error_message';
  return 'plain_text';
}

function parseKieSectionMap(raw, requiredSections) {
  const rawTrimmed = String(raw || '').trim();
  const strippedRaw = stripCodeFences(rawTrimmed);
  const parsedRaw = tryParseJsonText(strippedRaw);
  const detectedFormat = detectKieResponseFormat(rawTrimmed, parsedRaw, requiredSections);
  const result = {
    detectedFormat,
    sourcePath: '',
    preview: sanitizeKiePreviewText(rawTrimmed),
    parseFailureReason: '',
    foundSectionKeys: [],
    rawLength: rawTrimmed.length,
    sections: null
  };

  const directCandidates = collectSectionObjectCandidates(parsedRaw, requiredSections);
  if (directCandidates.length) {
    const winner = directCandidates.sort((a, b) => Object.keys(b.value || {}).length - Object.keys(a.value || {}).length)[0];
    result.sourcePath = winner.label;
    result.foundSectionKeys = Object.keys(winner.value || {});
    result.sections = normalizeAiSections(winner.value, requiredSections);
    return result;
  }

  const textCandidates = extractNestedJsonStringCandidates(parsedRaw);
  for (const candidate of textCandidates) {
    const stripped = stripCodeFences(candidate.value);
    const parsed = tryParseJsonText(stripped);
    const nestedCandidates = collectSectionObjectCandidates(parsed, requiredSections);
    if (nestedCandidates.length) {
      const winner = nestedCandidates.sort((a, b) => Object.keys(b.value || {}).length - Object.keys(a.value || {}).length)[0];
      result.sourcePath = `${candidate.label} -> ${winner.label}`;
      result.preview = sanitizeKiePreviewText(candidate.value);
      result.foundSectionKeys = Object.keys(winner.value || {});
      result.sections = normalizeAiSections(winner.value, requiredSections);
      return result;
    }
    const textSections = parseTextTitleSections(candidate.value, requiredSections);
    if (textSections) {
      result.sourcePath = `${candidate.label} -> text_titles`;
      result.preview = sanitizeKiePreviewText(candidate.value);
      result.foundSectionKeys = requiredSections.filter((key) => textSections[key]);
      result.sections = normalizeAiSections(textSections, requiredSections);
      return result;
    }
  }

  const rawTextSections = parseTextTitleSections(rawTrimmed, requiredSections);
  if (rawTextSections) {
    result.sourcePath = 'raw_text_titles';
    result.foundSectionKeys = requiredSections.filter((key) => rawTextSections[key]);
    result.sections = normalizeAiSections(rawTextSections, requiredSections);
    return result;
  }

  result.parseFailureReason = parsedRaw
    ? 'section_map_not_found_in_supported_paths'
    : 'raw_response_not_valid_json';
  if (detectedFormat === 'plain_text' && textCandidates.length) {
    result.preview = sanitizeKiePreviewText(textCandidates[0].value);
  }
  return result;
}

function detectRepeatedSentences(sections) {
  const map = new Map();
  for (const value of Object.values(sections || {})) {
    const sentences = splitReportSentences(String(value || ''))
      .map((item) => item.replace(/\s+/g, ' ').trim())
      .filter((item) => item.length >= 25 || buildRepeatKey(item));
    for (const sentence of sentences) {
      const key = buildRepeatKey(sentence) || sentence;
      map.set(key, { sentence, count: (map.get(key)?.count || 0) + 1 });
    }
  }
  return Array.from(map.values()).filter((item) => item.count >= 2);
}

function hasCompatibilityPromptPayload(promptPayload) {
  return Boolean(
    promptPayload?.partnerInfo?.name
    || promptPayload?.chartData?.compatibility
    || promptPayload?.compatibilitySummary
    || promptPayload?.rawBundle?.compatibility
  );
}

const REPORT_BATCHES = [
  { batchName: 'core', sections: ['핵심 요약', '사주 원국 해석'] },
  { batchName: 'timing', sections: ['대운', '세운', '월운', '운성'] },
  { batchName: 'analysis', sections: ['신살,귀인', '십성', '재물운', '직업운'] },
  { batchName: 'life', sections: ['애정운', '자녀운', '건강운', '실천 조언', '주의할 점'] },
  { batchName: 'concern', sections: ['고민에 대한 조언'] },
  { batchName: 'compatibility', sections: ['관계/궁합 해석'] }
];

const SECTION_PROMPT_TARGET_CHARS = {
  '핵심 요약': 800,
  '사주 원국 해석': 1100,
  '대운': 850,
  '세운': 900,
  '월운': 900,
  '운성': 700,
  '재물운': 850,
  '직업운': 850,
  '건강운': 850,
  '실천 조언': 850,
  '주의할 점': 850,
  '고민에 대한 조언': 1200,
  '관계/궁합 해석': 1400
};

const SECTION_PROMPT_TARGET_PARAGRAPHS = {
  '세운': 5,
  '월운': 5,
  '운성': 5,
  '고민에 대한 조언': 5,
  '관계/궁합 해석': 6
};

const KIE_BATCH_PROGRESS = {
  core: 88,
  timing: 90,
  analysis: 92,
  life: 94,
  concern: 96,
  compatibility: 97,
  html_render: 98,
  completed: 100
};

const KIE_BATCH_TIMEOUT_MS = {
  core: 90000,
  default: 120000
};

const KIE_BATCH_MAX_TOKENS = {
  core: 8000,
  timing: 12000,
  analysis: 12000,
  life: 12000,
  concern: 8000,
  compatibility: 10000,
  default: 8000
};

const SECTION_MIN_VISIBLE_CHARS = {
  '핵심 요약': 600,
  '사주 원국 해석': 800,
  '대운': 600,
  '세운': 600,
  '월운': 600,
  '운성': 500,
  '신살,귀인': 500,
  '십성': 500,
  '재물운': 600,
  '직업운': 600,
  '애정운': 500,
  '자녀운': 500,
  '건강운': 600,
  '실천 조언': 600,
  '주의할 점': 600,
  '고민에 대한 조언': 800,
  '관계/궁합 해석': 1000
};

const META_RESPONSE_PHRASES = [
  '한 번에 생성할 수 없습니다',
  '분량을 초과합니다',
  '여러 회차로 작성',
  '요청을 처리할 수 없습니다',
  '제공된 지시에는',
  '다음과 같이 나누어',
  '죄송합니다',
  '작성할 수 없습니다'
];

const KIE_POLICY_REFUSAL_PHRASES = [
  '죄송하지만',
  '수행할 수 없습니다',
  '도와드릴 수 없습니다',
  '특정한 운세',
  '사실처럼 단정',
  '성공 가능성',
  '예측할 수 없습니다',
  '제공된 정보만으로',
  '운세나 사업 성공',
  '상세한 사주 해석',
  '미래를 예측',
  '결정되어 있다',
  '단정할 수 없습니다'
];

const COMPATIBILITY_FORBIDDEN_PATTERNS = [
  /반드시\s*잘\s*맞/,
  /절대\s*맞지\s*않/,
  /결혼하면\s*성공/,
  /헤어질\s*가능성이\s*높/,
  /사업을\s*하면\s*성공/,
  /실패한다/,
  /운명(이다|적으로)/,
  /최악의\s*궁합/,
  /최고의\s*궁합/,
  /반드시\s*조심/,
  /미래가\s*정해져/,
  /확정적으로/,
  /성공\s*가능성이\s*높/,
  /이별\s*가능성이\s*높/,
  /결혼운이\s*정해져/,
  /사업운이\s*(좋|나쁘)/,
  /궁합은\s*매우\s*좋/,
  /궁합은\s*나쁘/
];

function getReportBatches(hasCompatibility) {
  const baseBatches = REPORT_BATCHES.filter((batch) => hasCompatibility || batch.batchName !== 'compatibility');
  if (!CONFIG.ai.singleSectionMode) return baseBatches;
  return baseBatches.flatMap((batch) => batch.sections.map((section) => ({
    batchName: `${batch.batchName}:${section}`,
    sections: [section],
    parentBatchName: batch.batchName,
    singleSectionMode: true
  })));
}

function getSectionMinVisibleChars(section) {
  return SECTION_MIN_VISIBLE_CHARS[section] || 500;
}

function getSectionPromptTargetChars(section) {
  return SECTION_PROMPT_TARGET_CHARS[section] || getSectionMinVisibleChars(section);
}

function getSectionMinParagraphs(section) {
  return section === '고민에 대한 조언' || section === '관계/궁합 해석' ? 5 : 3;
}

function getSectionPromptTargetParagraphs(section) {
  return SECTION_PROMPT_TARGET_PARAGRAPHS[section] || getSectionMinParagraphs(section);
}

function getSectionOwningBatchName(section = '') {
  const match = REPORT_BATCHES.find((batch) => Array.isArray(batch?.sections) && batch.sections.includes(section));
  return match?.batchName || null;
}

function getPrimaryFailedBatchName(failedSections = [], fallbackBatchName = 'kie_ai') {
  const orderedBatchNames = REPORT_BATCHES.map((batch) => batch.batchName);
  const candidates = Array.from(new Set((Array.isArray(failedSections) ? failedSections : [])
    .map((section) => getSectionOwningBatchName(section))
    .filter(Boolean)));
  if (!candidates.length) return getBatchRootName(fallbackBatchName || 'kie_ai') || 'kie_ai';
  const prioritized = orderedBatchNames.find((batchName) => candidates.includes(batchName));
  return prioritized || candidates[0] || getBatchRootName(fallbackBatchName || 'kie_ai') || 'kie_ai';
}

function canAcceptSectionLengthShortfall(section, length, minLength, paragraphCount, totalLength, minimumTotal) {
  const safeSection = String(section || '');
  if (!minLength || length >= minLength) return true;
  if (['고민에 대한 조언', '관계/궁합 해석', '핵심 요약', '사주 원국 해석'].includes(safeSection)) return false;
  const shortfall = minLength - length;
  const paragraphMinimum = getSectionMinParagraphs(safeSection);
  const paragraphOk = Number(paragraphCount || 0) >= paragraphMinimum;
  const totalOk = Number(totalLength || 0) >= Number(minimumTotal || 0);
  const withinAbsoluteTolerance = shortfall <= 40;
  const withinRatioTolerance = length >= Math.floor(minLength * 0.94);
  return paragraphOk && totalOk && (withinAbsoluteTolerance || withinRatioTolerance);
}

function getBatchRootName(batchName = '') {
  return String(batchName || '').split(':')[0] || '';
}

function getBatchProgress(batchName = '') {
  return KIE_BATCH_PROGRESS[getBatchRootName(batchName)] || 88;
}

function getBatchTimeoutMs(batchName = '') {
  const root = getBatchRootName(batchName);
  return KIE_BATCH_TIMEOUT_MS[root] || KIE_BATCH_TIMEOUT_MS.default;
}

async function persistBatchProgress(order, batchName, eventType, detail = {}) {
  if (!order) return;
  const currentStep = detail.currentStep || getBatchRootName(batchName) || 'kie_ai';
  const progress = Number.isFinite(Number(detail.progressOverride))
    ? Number(detail.progressOverride)
    : Math.max(getOrderProgress(order), getBatchProgress(batchName));
  const statusMessage = detail.statusMessage || buildGeneratingMessage(currentStep);
  updateOrderProgress(order, { status: 'generating', currentStep, progress, failedStep: null, statusMessage });
  if (eventType) order.logs.push(logLine(eventType, { batchName, ...detail }));
  await saveOrder(order);
}

function detectMetaResponseText(text) {
  const raw = String(text || '').trim();
  const matches = META_RESPONSE_PHRASES.filter((phrase) => raw.includes(phrase));
  return {
    detected: matches.length > 0,
    matches
  };
}

function isAcceptedJsonDetectedFormat(format = '') {
  return format === 'json' || format === 'json_wrapper';
}

function summarizeSectionLengths(sections, requiredSections) {
  return Object.fromEntries(requiredSections.map((key) => [key, countVisibleChars(sections?.[key] || '')]));
}

function validateSectionMap(sectionMap, promptPayload, meta = {}, options = {}) {
  return validateAiSections(sectionMap, promptPayload, meta, options);
}

function validateAiSections(sections, promptPayload, meta = {}, options = {}) {
  const requiredSections = options.requiredSections || buildRequiredAiSections(hasCompatibilityPromptPayload(promptPayload));
  const enforceTotalLength = options.enforceTotalLength !== false;
  const requireRawLength = options.requireRawLength === true;
  const requireJsonOnly = options.requireJsonOnly === true;
  const errors = [];
  const sectionErrors = Object.fromEntries(requiredSections.map((key) => [key, []]));
  if (requireJsonOnly && !isAcceptedJsonDetectedFormat(meta.detectedFormat || '')) {
    errors.push('json_only_response_required');
  }
  const paragraphCounts = {};
  const sectionLengths = {};
  const banned = /(api|json|system|model|data structure|raw|debug|missingfields|requiredfields|계산 확인 메모|fallback|prompt|engine|content-type|status\s*500|error|downloadurl|pdfpath|pdf)/i;
  for (const key of requiredSections) {
    const text = cleanSectionText(sections?.[key] || '');
    const paragraphs = countMeaningfulParagraphs(text);
    const length = countVisibleChars(text);
    paragraphCounts[key] = paragraphs;
    sectionLengths[key] = length;
    if (!text) {
      sectionErrors[key].push('누락');
      errors.push(`${key} 누락`);
    }
    const minParagraphs = getSectionMinParagraphs(key);
    const minLength = getSectionMinVisibleChars(key);
    if (text && paragraphs < minParagraphs) {
      sectionErrors[key].push('문단 수 부족');
      errors.push(`${key} 문단 수 부족`);
    }
    if (text && length < minLength) {
      sectionErrors[key].push('분량 부족');
      errors.push(`${key} 분량 부족`);
    }
    if (text && banned.test(text)) {
      sectionErrors[key].push('개발용 문구 포함');
      errors.push(`${key} 개발용 문구 포함`);
    }
    const metaResponse = detectMetaResponseText(text);
    if (text && metaResponse.detected) {
      sectionErrors[key].push('메타 응답 포함');
      errors.push(`${key} 메타 응답 포함`);
    }

    if (text && /(님\s+님|님님)/.test(text)) {
      sectionErrors[key].push('중복 호칭 포함');
      errors.push(`${key} 중복 호칭 포함`);
    }
  }
  const totalLength = Object.values(sectionLengths).reduce((sum, value) => sum + Number(value || 0), 0);
  const minimumTotal = requiredSections.reduce((sum, key) => sum + getSectionMinVisibleChars(key), 0);
  for (const key of requiredSections) {
    if (!sectionErrors[key]?.includes('분량 부족')) continue;
    const paragraphCount = paragraphCounts[key] || 0;
    const currentLength = sectionLengths[key] || 0;
    const minLength = getSectionMinVisibleChars(key);
    if (!canAcceptSectionLengthShortfall(key, currentLength, minLength, paragraphCount, totalLength, minimumTotal)) continue;
    sectionErrors[key] = sectionErrors[key].filter((item) => item !== '분량 부족');
    const errorLabel = `${key} 분량 부족`;
    const errorIndex = errors.indexOf(errorLabel);
    if (errorIndex >= 0) errors.splice(errorIndex, 1);
    console.log('[KIE AI VALIDATION] accepted slight shortfall', JSON.stringify({ section: key, length: currentLength, minLength, totalLength, minimumTotal }));
  }
  if (requireRawLength && Number(meta.rawLength || 0) < 500) errors.push('raw_response_too_short_or_parse_failed');
  if (enforceTotalLength && totalLength < minimumTotal) errors.push('total_section_length_too_short');
  if (Object.values(sectionLengths).every((value) => Number(value || 0) === 0)) errors.push('all_sections_empty_parser_error');
  const concern = String(promptPayload?.basicInfo?.concern || promptPayload?.concern || '').trim();
  if (concern && requiredSections.includes('고민에 대한 조언')) {
    const concernText = String(sections?.['고민에 대한 조언'] || '');
    const keywords = collectConcernKeywords(concern);
    if (keywords.length && !keywords.some((token) => concernText.includes(token))) {
      sectionErrors['고민에 대한 조언'].push('사용자 질문 직접 응답 부족');
      errors.push('고민에 대한 조언이 사용자 질문에 직접 답하지 않음');
    }
    if (/온라인\s*사주\s*사업/.test(concern)) {
      const checks = [
        /(사업|창업|운영)/, /(상담형|콘텐츠형|리포트형|브랜딩형)/, /(수익|매출|수익화)/,
        /(고객|응대|소통)/, /(시작|주의점|리스크)/, /(혼자|협업|파트너)/,
        /(2026|타이밍|시기)/, /(3개월)/, /(6개월)/, /(1년)/, /(실패 가능성|실패를 줄|리스크를 줄)/, /(최종 결론|결론)/
      ];
      const passed = checks.filter((regex) => regex.test(concernText)).length;
      if (passed < 10) {
        sectionErrors['고민에 대한 조언'].push('온라인 사주 사업 질문 필수 항목 부족');
        errors.push('온라인 사주 사업 질문 필수 항목 부족');
      }
    }
  }
  if (hasCompatibilityPromptPayload(promptPayload) && requiredSections.includes('관계/궁합 해석')) {
    const relationText = String(sections?.['관계/궁합 해석'] || '');
    const relationChecks = [
      /(기질|성향|차이)/,
      /(소통|대화|말투)/,
      /(감정|표현)/,
      /(갈등|충돌|마찰)/,
      /(보완|장점|강점)/,
      /(역할|분담|협업|함께 일)/,
      /(현실|금전|생활)/,
      /(조언|실천|패턴|방법|안정)/
    ];
    if (relationChecks.filter((regex) => regex.test(relationText)).length < 5) {
      sectionErrors['관계/궁합 해석'].push('핵심 포인트 부족');
      errors.push('관계/궁합 해석 핵심 포인트 부족');
    }
    const refusal = detectKiePolicyRefusal(relationText);
    if (refusal.detected) {
      sectionErrors['관계/궁합 해석'].push('거절 응답 포함');
      errors.push('관계/궁합 해석 거절 응답 포함');
    }
    const deterministic = COMPATIBILITY_FORBIDDEN_PATTERNS.some((pattern) => pattern.test(relationText));
    if (deterministic) {
      sectionErrors['관계/궁합 해석'].push('단정적 표현 포함');
      errors.push('관계/궁합 해석 단정적 표현 포함');
    }
  }
  const repeated = detectRepeatedSentences(sections);
  if (repeated.length) errors.push('같은 문장 반복 과다');
  const passedSections = requiredSections.filter((key) => sectionErrors[key].length === 0);
  const failedSections = requiredSections.filter((key) => sectionErrors[key].length > 0);
  return {
    ok: errors.length === 0,
    reason: errors.length ? (errors.includes('raw_response_too_short_or_parse_failed') || errors.includes('all_sections_empty_parser_error') ? 'raw_response_too_short_or_parse_failed' : 'section_validation_failed') : 'ok',
    errors,
    sectionErrors,
    passedSections,
    failedSections,
    paragraphCounts,
    sectionLengths,
    totalSectionLength: totalLength,
    minimumTotalLength: minimumTotal,
    rawLength: Number(meta.rawLength || 0),
    detectedFormat: meta.detectedFormat || 'unknown',
    sourcePath: meta.sourcePath || '',
    parseFailureReason: meta.parseFailureReason || '',
    foundSectionKeys: meta.foundSectionKeys || [],
    repeated: repeated.slice(0, 6)
  };
}

function buildConcernSpecificInstruction(concern, hasCompatibility, birthTimeUnknown = false) {
  const lines = [
    '각 섹션은 최소 3문단 이상 작성하고, 각 섹션의 첫 부분에 해당 주제가 무엇을 의미하는지 1~2문장으로 짧게 설명한 뒤 실제 풀이를 이어가세요.',
    '각 섹션은 의미 설명, 핵심 해석, 실제 생활 예시, 주의할 점, 실천 조언 2~3개, 정리하면 요약 순서를 자연스럽게 반영하세요.',
    '한 문단은 2~4문장 이내로 유지하고 모바일에서 읽기 쉽게 긴 문단은 나누세요.',
    '추상적인 일반론 대신 실제 상담 장면이 떠오르는 구체 예시를 포함하세요.',
    '사주 원국, 오행, 십성, 강약, 용신, 대운, 세운, 월운, 궁합 자료를 실제 해석 문장에 직접 연결하세요.',
    '편관격, 신약, 용신, 희신, 재성, 관성, 비겁 같은 용어가 처음 나오면 쉬운 설명과 "쉽게 말하면" 풀이를 반드시 붙이세요.',
    '사주 해석은 자기이해와 현실 점검을 돕는 참고용 조언입니다. 미래를 확정하는 예언처럼 단정하지 말고, 반드시·절대·확실히 같은 표현 대신 가능성·경향성 중심으로 설명하세요.',
    '같은 문장과 조언이 여러 섹션에서 반복되지 않도록 관점과 표현을 바꾸고, 대운·세운·월운은 서로 다른 역할로 구분해 쓰세요.',
    '고민에 대한 조언은 최소 5문단 이상 작성하고 사용자의 질문에 직접 답하세요. 같은 문장을 복사하지 말고 현실적인 선택 기준과 행동 순서를 제시하세요.'
  ];
  if (birthTimeUnknown) lines.push('사용자가 출생시간을 모르는 상태입니다. 따라서 시주를 확정하지 말고, 생년월일 중심으로 해석하세요. 시주 기반의 세부 해석, 자녀운, 말년운, 시간대에 민감한 신살 해석은 단정하지 말고 보수적으로 작성하세요. 리포트에는 출생시간이 확인되지 않아 시주를 기준으로 한 일부 세부 해석은 제한적으로 참고하는 것이 좋다는 취지의 안내를 자연스럽게 반영하세요.');
  if (hasCompatibility) lines.push('관계/궁합 해석은 최소 5문단 이상 작성하고, 두 사람의 원국과 compatibility 자료를 함께 반영하세요. 이름을 언급할 때는 반드시 이름 뒤에 님을 붙여 작성하세요.');
  if (/온라인\s*사주\s*사업/.test(String(concern || ''))) {
    lines.push('사용자 질문이 온라인 사주 사업에 관한 경우, 온라인 사주 사업과 사주 구조의 적합성, 상담형/콘텐츠형/리포트형/브랜딩형 적합도, 수익화 가능성, 고객 응대 스타일, 사업 시작 시 주의점, 혼자 운영 vs 협업, 2026년 기준 실행 타이밍, 3개월 실행 계획, 6개월 실행 계획, 1년 운영 전략, 실패 가능성을 줄이는 조건, 최종 결론을 반드시 모두 포함하세요.');
  }
  return lines.join(' ');
}

function buildRetryInstruction(reason, outputMode = 'json', requiredSections = []) {
  const sectionGuide = requiredSections.length ? `이번 호출에서 허용된 섹션은 ${requiredSections.join(', ')} 입니다.` : '';
  if (outputMode === 'text_titles') {
    const base = `이전 응답은 실패했습니다. 이번에는 JSON이 아니라 순수 텍스트만 반환하세요. 코드블록, 마크다운 설명문, 사전 안내 문구를 금지합니다. 각 제목은 반드시 \`## 제목\` 형식을 쓰고, 제목 아래 본문만 작성하세요. 요청받은 섹션만 작성하고 다른 섹션은 절대 쓰지 마세요. ${sectionGuide}`;
    return reason ? `${base} 이전 실패 사유: ${reason}` : base;
  }
  const base = `이전 응답은 필수 JSON 섹션 형식이 아니었습니다. 반드시 JSON 객체만 반환하세요. 설명문, 코드블록, 마크다운을 붙이지 마세요. 요청받은 섹션 key만 포함하고 각 value는 빈 문자열 없이 충분한 문단과 분량으로 작성하세요. 각 문단은 2~4문장 이내로 쓰고 실제 생활 예시, 주의점, 실천 조언 2~3개를 포함하세요. 처음 나오는 사주 용어는 쉬운 설명과 쉽게 말하면 풀이를 붙이세요. 같은 문장 반복을 피하고, 신약·편관격·용신·희신 같은 핵심 표현도 같은 문장으로 복사하지 말며, 섹션 끝에는 정리하면 요약을 넣으세요. 모든 섹션은 존댓말 설명체(합니다/입니다/할 수 있습니다)로 작성하고, 이름을 언급할 때는 반드시 님을 붙이되 중복 호칭은 금지합니다. ${sectionGuide}`;
  return reason ? `${base} 이전 실패 사유: ${reason}` : base;
}

function estimateApproxTokens(value) {
  const chars = typeof value === 'string' ? value.length : JSON.stringify(value || {}).length;
  return Math.ceil(chars / 2.4);
}

function buildAiPayloadForMode(promptPayload, requiredSections, mode = 'full_report') {
  const chartData = promptPayload?.chartData || {};
  const compact = {
    basicInfo: promptPayload?.basicInfo || {},
    partnerInfo: promptPayload?.partnerInfo || null,
    pillars: chartData.pillars || {},
    pillarDetails: chartData.pillarDetails || {},
    fiveElements: chartData.fiveElements || {},
    tenGods: chartData.tenGods || {},
    gyeokguk: chartData.gyeokguk || null,
    strength: chartData.strength || null,
    yongsin: chartData.yongsin || null,
    johu: chartData.johu || null,
    daeunSummary: chartData.daeun || null,
    futureFiveYearsSummary: chartData.futureFiveYears || [],
    futureSixMonthsSummary: chartData.futureSixMonths || [],
    compatibilitySummary: chartData.compatibility || null,
    concern: promptPayload?.basicInfo?.concern || '',
    consistencyWarnings: promptPayload?.internalReference?.consistencyWarnings || [],
    analysisNotes: promptPayload?.analysisNotes || {},
    requiredSections
  };
  if (mode === 'full_report') {
    return {
      ...compact,
      rawBundle: promptPayload?.rawBundle || {}
    };
  }
  return compact;
}

function buildTextTitleTemplate(requiredSections) {
  return requiredSections.map((title) => `## ${title}`).join('\n\n');
}

function buildAiRequestSizeSummary({ systemPrompt, userText, requestBody, payloadMode, payloadForAi }) {
  const rawBundleKeys = Object.keys(payloadForAi?.rawBundle || {});
  const messagesCount = Array.isArray(requestBody?.messages)
    ? requestBody.messages.length
    : Array.isArray(requestBody?.input)
      ? requestBody.input.length
      : 0;
  return {
    payloadMode,
    promptChars: systemPrompt.length + userText.length,
    messagesCount,
    approxTokens: estimateApproxTokens(systemPrompt) + estimateApproxTokens(userText),
    rawBundleKeys,
    hasRawMansae: Boolean(payloadForAi?.rawBundle?.mansae),
    hasRawSaju: Boolean(payloadForAi?.rawBundle?.saju),
    hasRawPeriod: Boolean(payloadForAi?.rawBundle?.period),
    hasRawCompatibility: Boolean(payloadForAi?.rawBundle?.compatibility),
    requestBodyChars: JSON.stringify(requestBody).length,
    requestBodyApproxTokens: estimateApproxTokens(requestBody)
  };
}

function getAiErrorMessage(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  return String(
    parsed.msg
    || parsed.message
    || parsed.error?.message
    || parsed.error_description
    || parsed.detail
    || parsed.result?.message
    || ''
  ).trim();
}

function detectUpstreamAiError(raw, httpStatus, requiredSections) {
  const parsed = tryParseJsonText(raw);
  const bodyCode = parsed?.code ?? parsed?.statusCode ?? parsed?.error?.code ?? null;
  const bodyMessage = getAiErrorMessage(parsed);
  if (!parsed || typeof parsed !== 'object') {
    return {
      isError: !httpStatus || httpStatus >= 400,
      bodyCode: httpStatus || null,
      bodyMessage: httpStatus >= 400 ? 'http_error' : '',
      detectedFormat: 'plain_text'
    };
  }
  if (hasLikelySectionKeys(parsed, requiredSections) || parsed?.sections || parsed?.data?.sections || parsed?.result?.sections) {
    return { isError: false, bodyCode, bodyMessage, detectedFormat: 'json' };
  }
  const numericBodyCode = Number(bodyCode);
  if ((Number.isFinite(numericBodyCode) && numericBodyCode >= 400) || parsed?.error || /server exception|try again later|quota|insufficient|invalid api key/i.test(bodyMessage)) {
    return {
      isError: true,
      bodyCode: Number.isFinite(numericBodyCode) ? numericBodyCode : (bodyCode || 'error'),
      bodyMessage,
      detectedFormat: detectKieResponseFormat(raw, parsed, requiredSections)
    };
  }
  return { isError: false, bodyCode, bodyMessage, detectedFormat: detectKieResponseFormat(raw, parsed, requiredSections) };
}

function resolveAiStyle() {
  const configured = String(CONFIG.ai.style || '').trim();
  if (configured) return configured;
  return String(CONFIG.ai.path || '').includes('/responses') ? 'responses' : 'chat_completions';
}

function resolveAiEndpointPath(style = 'chat_completions') {
  let configured = String(CONFIG.ai.path || '').trim();
  if (!configured) configured = style === 'responses' ? '/v1/responses' : '/gpt-5-2/v1/chat/completions';
  if (!configured.startsWith('/')) configured = `/${configured}`;
  return configured;
}

function getAiEndpointCandidates(style = 'chat_completions') {
  const configured = resolveAiEndpointPath(style);
  const candidates = [configured];
  if (style === 'chat_completions') {
    candidates.push('/gpt-5-2/v1/chat/completions');
    candidates.push('/v1/chat/completions');
  } else {
    candidates.push('/gpt-5-2/v1/responses');
    candidates.push('/v1/responses');
  }
  return Array.from(new Set(candidates.filter(Boolean)));
}

function getBatchMaxTokens(batchName = '') {
  const root = getBatchRootName(batchName);
  const configured = Number(CONFIG.ai.maxTokens) || KIE_BATCH_MAX_TOKENS.default;
  const preferred = KIE_BATCH_MAX_TOKENS[root] || KIE_BATCH_MAX_TOKENS.default;
  return Math.min(configured, preferred);
}

function buildAiAttemptPlan(batch, attempt) {
  const root = getBatchRootName(batch?.batchName || '');
  const batchMaxTokens = getBatchMaxTokens(root);
  if (attempt === 1) {
    return {
      mode: 'compact_report',
      outputMode: 'json',
      maxTokens: batchMaxTokens,
      includeRawBundle: false
    };
  }
  if (attempt === 2) {
    return {
      mode: 'compact_report',
      outputMode: 'json',
      maxTokens: batchMaxTokens,
      includeRawBundle: false
    };
  }
  return {
    mode: 'compact_report',
    outputMode: 'json',
    maxTokens: Math.min(batchMaxTokens, root === 'concern' ? 8000 : batchMaxTokens),
    includeRawBundle: false
  };
}


function createKieBatchError(message, detail = {}) {
  const error = new Error(message || 'KIE AI batch generation failed');
  error.failedStep = detail.failedStep || 'kie_ai';
  error.currentStep = detail.currentStep || getBatchRootName(detail.batchName || detail.failedBatch || '') || 'kie_ai';
  error.failedBatch = detail.failedBatch || getBatchRootName(detail.batchName || detail.currentStep || '') || null;
  error.failedSections = Array.isArray(detail.failedSections)
    ? Array.from(new Set(detail.failedSections.filter(Boolean)))
    : [];
  const progressSource = Number.isFinite(Number(detail.progress))
    ? Number(detail.progress)
    : getBatchProgress(detail.batchName || detail.currentStep || detail.failedBatch || 'kie_ai');
  error.progress = Number.isFinite(Number(progressSource)) ? Number(progressSource) : 88;
  if (detail.userMessage) error.userMessage = detail.userMessage;
  return error;
}

function shouldSplitBatchOnValidation(batch, validation) {
  if (!batch?.sections || batch.sections.length <= 1) return false;
  const joined = [validation?.reason || '', ...(validation?.errors || [])].join(' | ');
  return /(분량 부족|문단 수 부족|메타 응답 포함|json_only_response_required|section_map_not_found_in_supported_paths|raw_response_not_valid_json|all_sections_empty_parser_error|total_section_length_too_short|누락)/.test(joined);
}

function buildSingleSectionPromptGuide(section) {
  const base = [
    `이번 호출에서는 "${section}" 섹션 하나만 작성하세요.`,
    `최소 ${getSectionPromptTargetChars(section)}자 이상 작성하세요.`,
    `반드시 ${getSectionPromptTargetParagraphs(section)}문단 이상 작성하세요.`,
    '각 문단은 2~4문장 이내로 작성하고, 너무 긴 문단은 나누세요.',
    '각 섹션은 ① 해당 주제가 무엇을 의미하는지 짧은 설명 ② 사주에서 보이는 핵심 ③ 실제 생활에서 나타날 수 있는 모습 ④ 주의할 점 ⑤ 실천 조언 2~3개 ⑥ 정리하면 요약 순서를 따르세요.',
    '짧게 요약하지 말고 실제 생활 예시, 주의점, 실천 조언을 반드시 포함하세요.',
    '편관격, 신약, 용신, 희신, 재성, 관성, 비겁 같은 사주 용어가 처음 나오면 반드시 쉬운 설명을 덧붙이고, "쉽게 말하면" 식의 풀이를 포함하세요.',
    '같은 문장과 같은 조언을 반복하지 말고, 신약·편관격·용신·희신 같은 핵심 표현도 필요한 맥락에서만 언급하며 섹션 주제에 맞게 표현과 관점을 바꾸세요.',
    '섹션 끝에는 반드시 "정리하면"으로 시작하는 짧은 요약을 넣으세요.',
    `반드시 {"${section}":"본문"} 형식의 JSON 객체만 반환하세요.`,
    '해당 섹션이 무엇을 살펴보는 항목인지 1~2문장으로 짧게 설명한 뒤 본문 풀이를 이어가세요.',
    '모든 문장은 존댓말 설명체(합니다/입니다/할 수 있습니다)로 작성하세요.',
    '이름을 언급할 때는 반드시 이름 뒤에 님을 붙이되, 이미 님이 붙은 이름에 님을 다시 붙이지 마세요.'
  ];
  if (section === '고민에 대한 조언') {
    base.push('반드시 {"고민에 대한 조언":"..."} 형식의 JSON만 반환하세요. 다른 key는 금지합니다.');
    base.push('최소 800자 이상, 최소 5문단 이상 작성하고 사용자의 질문에 직접 답하세요.');
    base.push('단정적 표현을 피하고 현실적인 선택 기준, 행동 순서, 실천 조언을 분명하게 제시하세요.');
    base.push('이름 뒤에는 반드시 님을 붙이되 "님 님", "님님" 같은 중복 호칭은 금지합니다.');
  }
  if (section === '관계/궁합 해석') {
    base.push('관계 성향, 소통 방식, 갈등 포인트, 보완점, 현실 조언을 모두 포함하세요.');
    base.push('결혼/이별/성공/실패를 단정하지 말고, 운명론적 표현과 확정적 예언을 금지하세요.');
    base.push('사과문, 거절문, 안내문, 코드블록, 요청받지 않은 다른 key를 절대 쓰지 마세요.');
  }
  return base.join(' ');
}

function buildSectionRequirementGuide(sections, isolated = false) {
  return sections.map((section) => isolated
    ? buildSingleSectionPromptGuide(section)
    : `${section}: 최소 ${getSectionPromptTargetParagraphs(section)}문단, 최소 ${getSectionPromptTargetChars(section)}자, 각 문단 2~4문장 이내, 실제 예시/주의점/실천 조언 2~3개 포함, 섹션 시작 전에 1~2문장의 짧은 주제 설명 포함, 처음 나오는 사주 용어는 쉬운 설명 추가, 같은 표현 반복 금지, 섹션 끝에 정리하면 요약 추가, 존댓말 설명체 유지, 이름 언급 시 반드시 님 사용`).join(' | ');
}

function isCompatibilityOnlyBatch(batch) {
  return Array.isArray(batch?.sections) && batch.sections.length === 1 && batch.sections[0] === '관계/궁합 해석';
}

function getBatchMaxAttempts(batch) {
  const root = getBatchRootName(batch?.batchName || '');
  if (isCompatibilityOnlyBatch(batch)) return 3;
  if (Array.isArray(batch?.sections) && batch.sections.length === 1) return 3;
  if (['core', 'timing', 'analysis', 'life', 'concern', 'compatibility'].includes(root)) return 3;
  return 3;
}

function detectKiePolicyRefusal(text) {
  const raw = String(text || '').trim();
  const matches = KIE_POLICY_REFUSAL_PHRASES.filter((phrase) => raw.includes(phrase));
  return {
    detected: matches.length > 0,
    matches
  };
}

function buildCompatibilitySpecificInstruction(attempt = 1) {
  const sharedRules = [
    '섹션 제목은 관계/궁합 해석으로 유지하되, 본문은 관계 분석과 소통 코칭 중심으로 작성하세요.',
    '반드시 JSON 객체만 반환하고, key는 관계/궁합 해석 하나만 사용하세요.',
    '반드시 {"관계/궁합 해석":"본문"} 형식의 순수 JSON만 반환하세요.',
    '최소 1600자 이상, 최소 6문단 이상, 각 문단 2~3문장 이상으로 작성하세요.',
    '이름을 언급할 때는 반드시 이름 뒤에 님을 붙이고, 모든 문장은 존댓말 설명체(합니다/입니다/할 수 있습니다)로 작성하세요.',
    '관계 성향, 소통 방식, 갈등 포인트, 보완점, 역할 분담, 금전과 현실 문제, 안정적인 대화 조언을 모두 포함하세요.',
    '결혼, 이별, 성공, 실패, 운명, 최고, 최악 같은 단정적 표현을 금지합니다.',
    '사과문, 거절문, 안내문, 코드블록, 마크다운, 추가 key를 절대 쓰지 마세요.'
  ].join(' ');
  if (attempt === 1) {
    return `${sharedRules} 다음 내용은 운세 예측이나 결혼/이별/성공/실패에 대한 단정이 아닙니다. 두 사람의 관계 성향과 소통 방식을 이해하기 위한 참고용 관계 분석 문서입니다. 생년월일과 사주 정보는 전통적 성향 분석의 참고 자료로만 사용하세요. 미래 결과를 확정적으로 말하지 말고, 두 사람의 기질 차이, 감정 표현 방식, 갈등이 생기기 쉬운 지점, 서로 보완되는 부분, 함께 생활하거나 일할 때의 역할 분담, 돈과 현실 문제를 다루는 방식, 관계를 안정적으로 유지하기 위한 대화법과 실천 조언을 중심으로 작성하세요. 이 관계는 단정적인 좋고 나쁨보다 조율 방식이 중요하다는 톤을 유지하세요.`;
  }
  if (attempt === 2) {
    return `${sharedRules} 이 글은 운세 예측이나 성공/실패 단정이 아니라, 두 사람의 성향 차이와 소통 방식을 설명하는 관계 코칭 문서입니다. 생년월일 정보는 전통적 성향 분석의 참고 자료로만 사용하고, 미래 결과를 단정하지 마세요. 두 사람의 관계 흐름은 서로의 차이를 이해할수록 안정된다는 관점으로, 감정 확인 대화, 갈등 조율, 속도 차이 이해, 생활 습관 조정, 현실적인 협력 방식을 중심으로 작성하세요.`;
  }
  return `${sharedRules} 두 사람의 관계를 성격, 소통, 갈등 관리, 역할 분담, 함께 생활하거나 일할 때의 주의점 중심으로 설명하세요. 미래 사건을 예측하거나 좋고 나쁨을 단정하지 마세요. 사주 용어는 최소한으로만 사용하고, 상담 참고용 관계 코칭 문장으로 작성하세요. 결혼/이별/성공/실패를 판단하지 말고, 서로에게 도움이 되는 대화법과 생활 조율 팁을 분명하게 제시하세요.`;
}

function buildBatchWaves(batches) {
  const ordered = Array.isArray(batches) ? batches.slice() : [];
  if (!ordered.length) return [];
  const usesSingleSectionMode = ordered.some((batch) => String(batch?.batchName || '').includes(':'));
  if (usesSingleSectionMode) {
    const waves = [];
    for (let index = 0; index < ordered.length; index += 3) {
      waves.push(ordered.slice(index, index + 3));
    }
    return waves;
  }
  const preferred = [
    ['core', 'timing', 'analysis'],
    ['life', 'concern', 'compatibility']
  ];
  const consumed = new Set();
  const waves = preferred.map((group) => group
    .map((name) => ordered.find((batch) => batch.batchName === name))
    .filter(Boolean)
    .filter((batch) => {
      if (consumed.has(batch.batchName)) return false;
      consumed.add(batch.batchName);
      return true;
    }))
    .filter((wave) => wave.length > 0);
  const remaining = ordered.filter((batch) => !consumed.has(batch.batchName));
  for (let index = 0; index < remaining.length; index += 3) {
    waves.push(remaining.slice(index, index + 3));
  }
  return waves;
}

async function generateKieBatch(promptPayload, batch, endpointPath, order = null) {
  let retryReason = '';
  let lastError = null;
  let lastValidation = null;
  const isSingleSection = batch.sections.length === 1;
  const isCompatibilityBatch = isCompatibilityOnlyBatch(batch);
  const maxAttempts = getBatchMaxAttempts(batch);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (isCompatibilityBatch) {
      const attemptLabel = attempt === 1 ? 'attempt 1' : attempt === 2 ? 'attempt 2 safe prompt' : 'attempt 3 conservative prompt';
      console.log('[KIE AI COMPATIBILITY] start', JSON.stringify({ batchName: batch.batchName }));
      console.log('[KIE AI COMPATIBILITY]', attemptLabel);
    }
    const plan = buildAiAttemptPlan(batch, attempt);
    const payloadForAi = buildAiPayloadForMode(promptPayload, batch.sections, plan.mode);
    plan.payloadForAi = payloadForAi;
    const systemPrompt = [
      '당신은 숙련된 한국어 사주 해석 상담사입니다.',
      '반드시 한국어로만 작성하세요.',
      '반드시 JSON 객체만 반환하세요.',
      '마크다운 코드블록 금지, 설명문 금지, 사과문 금지, 안내문 금지입니다.',
      'API, JSON, 시스템, 모델, 데이터 구조, debug, downloadUrl, PDF 같은 기술/개발 문구는 절대 드러내지 마세요.',
      '모든 섹션은 존댓말 설명체로 작성하세요. "합니다", "입니다", "할 수 있습니다" 말투를 사용하고 "한다", "된다", "좋다", "필요하다" 같은 단정형 어미는 피하세요.',
      '각 섹션의 첫 부분에는 해당 주제가 무엇을 보는 항목인지 1~2문장으로 짧게 설명한 뒤 실제 풀이를 이어가세요.',
      '각 섹션은 핵심 해석, 실제 생활 예시, 주의할 점, 실천 조언 2~3개가 자연스럽게 드러나도록 구성하세요.',
      '한 문단은 2~4문장 이내로 유지하고, 너무 긴 문단은 나누세요.',
      '이름을 언급할 때는 반드시 이름 뒤에 "님"을 붙여 작성하되, 이미 님이 붙은 이름에 님을 다시 붙이지 마세요. "님 님", "님님" 같은 중복은 금지합니다.',
      '편관격, 신약, 용신, 희신, 재성, 관성, 비겁 같은 사주 용어가 처음 나오면 쉬운 설명과 "쉽게 말하면" 풀이를 반드시 붙이세요.',
      '같은 문장과 조언을 여러 섹션에서 반복하지 말고, 섹션마다 관점과 예시를 다르게 쓰세요. 신약, 편관격, 용신, 희신 등은 필요한 곳에서만 간결하게 언급하고 같은 설명을 복사하지 마세요.',
      '대운은 장기 흐름, 세운은 해당 연도의 일·돈·관계·건강 또는 상반기/하반기 흐름, 월운은 이번 달 실천 포인트 중심으로 서로 다르게 작성하세요.',
      '건강운 끝에는 건강운은 의학적 진단이 아니라 생활 습관을 점검하기 위한 참고용 해석이며, 불편한 증상이 있다면 전문의 상담을 권장한다는 안내를 자연스럽게 포함하세요.',
      '사주 해석은 자기이해와 현실 점검을 돕는 참고용 조언입니다. 미래를 확정하는 예언처럼 단정하지 말고, 반드시·절대·확실히 같은 표현 대신 가능성·경향성 중심으로 설명하세요.',
      '반드시 요청받은 섹션 key만 포함하세요. 다른 섹션은 절대 작성하지 마세요.',
      '각 섹션 값에는 실제 리포트 본문만 작성하세요.',
      '"한 번에 작성할 수 없습니다" 같은 메타 문장을 절대 쓰지 마세요.',
      buildSectionRequirementGuide(batch.sections, isSingleSection),
      buildConcernSpecificInstruction(promptPayload?.basicInfo?.concern || '', batch.sections.includes('관계/궁합 해석'), promptPayload?.basicInfo?.birthTimeUnknown === true),
      isCompatibilityBatch ? buildCompatibilitySpecificInstruction(attempt) : '',
      attempt > 1 ? buildRetryInstruction(retryReason, 'json', batch.sections) : ''
    ].filter(Boolean).join(' ');
    const userText = JSON.stringify({
      batchName: batch.batchName,
      sectionsToWrite: batch.sections,
      outputMode: 'json',
      outputRules: {
        jsonOnly: true,
        noMarkdown: true,
        noMeta: true,
        noExtraSections: true
      },
      promptPayload: payloadForAi
    });

    console.log('[KIE AI BATCH] start', JSON.stringify({ batchName: batch.batchName, attempt, endpointPath, outputMode: 'json' }));
    console.log('[KIE AI BATCH] batchName', batch.batchName);
    console.log('[KIE AI BATCH] sections', JSON.stringify(batch.sections));

    const result = await callAiProvider({
      label: 'KIE AI BATCH',
      attempt,
      payloadMode: plan,
      outputMode: 'json',
      systemPrompt,
      userText,
      requiredSections: batch.sections,
      endpointPathOverride: endpointPath,
      timeoutMs: getBatchTimeoutMs(batch.batchName)
    });

    if (!result.ok) {
      lastError = createKieBatchError(result.upstreamError?.bodyMessage || 'KIE upstream error', {
        batchName: batch.batchName,
        failedSections: batch.sections
      });
      if (result.upstreamError?.bodyMessage === 'kie_ai_timeout') {
        lastError.userMessage = '리포트 해석 생성 단계에서 응답이 지연되었습니다. 잠시 후 다시 시도해주세요.';
        console.log('[KIE AI BATCH] error timeout', JSON.stringify({ batchName: batch.batchName, attempt, timeoutMs: getBatchTimeoutMs(batch.batchName) }));
      }
      retryReason = `${result.upstreamError?.bodyCode || 'error'}:${result.upstreamError?.bodyMessage || 'upstream_error'}`;
      console.log('[KIE AI BATCH] error type', JSON.stringify({ batchName: batch.batchName, attempt, type: result.upstreamError?.type || 'unknown' }));
      console.log('[KIE AI BATCH] error message', JSON.stringify({ batchName: batch.batchName, attempt, message: result.upstreamError?.bodyMessage || 'upstream_error' }));
      console.log('[KIE AI BATCH] failed batchName', JSON.stringify({ batchName: batch.batchName, attempt, willRetry: attempt < maxAttempts && result.upstreamError?.type !== 'KIE_UPSTREAM_HTTP_ERROR' }));
      const shouldRetry = attempt < maxAttempts && result.upstreamError?.type !== 'KIE_UPSTREAM_HTTP_ERROR';
      if (shouldRetry) {
        await persistBatchProgress(order, batch.batchName, 'kie_batch_retry', { attempt, reason: retryReason });
        console.log('[KIE AI BATCH] retry start', JSON.stringify({ batchName: batch.batchName, reason: retryReason }));
        continue;
      }
      throw lastError;
    }

    console.log('[KIE AI BATCH] response length', JSON.stringify({ batchName: batch.batchName, rawLength: result.raw.length }));
    if (isCompatibilityBatch) {
      console.log('[KIE AI COMPATIBILITY] raw length', JSON.stringify({ rawLength: result.raw.length }));
    }
    const policyRefusal = detectKiePolicyRefusal(result.raw);
    if (isCompatibilityBatch && policyRefusal.detected) {
      console.log('[KIE AI BATCH] policy refusal detected', JSON.stringify({ batchName: batch.batchName, attempt, matches: policyRefusal.matches }));
      console.log('[KIE AI COMPATIBILITY] refusal detected', JSON.stringify({ attempt, matches: policyRefusal.matches }));
      retryReason = policyRefusal.matches.join(', ') || 'policy_refusal_detected';
      if (attempt < maxAttempts) {
        await persistBatchProgress(order, batch.batchName, 'kie_batch_retry', { attempt, reason: retryReason, policyRefusal: true });
        console.log('[KIE AI BATCH] retry start', JSON.stringify({ batchName: batch.batchName, reason: retryReason, safeMode: true }));
        continue;
      }
      throw createKieBatchError('KIE AI compatibility policy refusal', {
        batchName: batch.batchName,
        failedSections: batch.sections,
        userMessage: '리포트 해석 생성 단계에서 문제가 발생했습니다. 잠시 후 다시 시도해주세요.'
      });
    }

    const metaResponse = detectMetaResponseText(result.raw);
    if (metaResponse.detected) {
      console.log('[KIE AI] meta response detected', JSON.stringify({ batchName: batch.batchName, matches: metaResponse.matches }));
      if (!isSingleSection) {
        return { ok: false, splitRecommended: true, splitReason: 'meta_response_detected', matches: metaResponse.matches, partialSections: {} };
      }
      lastError = createKieBatchError('KIE AI meta response detected', { batchName: batch.batchName, failedSections: batch.sections });
      retryReason = metaResponse.matches.join(', ') || 'meta_response_detected';
      if (attempt < maxAttempts) {
        await persistBatchProgress(order, batch.batchName, 'kie_batch_retry', { attempt, reason: retryReason });
        console.log('[KIE AI BATCH] retry start', JSON.stringify({ batchName: batch.batchName, reason: retryReason }));
        continue;
      }
      throw lastError;
    }

    const parsedMeta = parseKieSectionMap(result.raw, batch.sections);
    const normalized = parsedMeta.sections || Object.fromEntries(batch.sections.map((key) => [key, '']));
    const validation = validateSectionMap(normalized, promptPayload, parsedMeta, {
      requiredSections: batch.sections,
      enforceTotalLength: true,
      requireRawLength: false,
      requireJsonOnly: true
    });
    lastValidation = validation;
    console.log('[KIE AI BATCH] parsed section keys', JSON.stringify(validation.foundSectionKeys.length ? validation.foundSectionKeys : Object.keys(normalized)));
    console.log('[KIE AI BATCH] section lengths', JSON.stringify(validation.sectionLengths));
    console.log('[KIE AI BATCH] passed sections', JSON.stringify(validation.passedSections || []));
    console.log('[KIE AI BATCH] failed sections', JSON.stringify(validation.failedSections || []));
    console.log('[KIE AI BATCH] validation result', JSON.stringify(validation));
    if (isCompatibilityBatch) {
      console.log('[KIE AI COMPATIBILITY] parsed keys', JSON.stringify(validation.foundSectionKeys.length ? validation.foundSectionKeys : Object.keys(normalized)));
      console.log('[KIE AI COMPATIBILITY] section length', JSON.stringify(validation.sectionLengths));
      console.log('[KIE AI COMPATIBILITY] paragraph count', JSON.stringify(validation.paragraphCounts));
      console.log('[KIE AI COMPATIBILITY] validation result', JSON.stringify({ ok: validation.ok, errors: validation.errors, failedSections: validation.failedSections }));
    }
    if (validation.ok) {
      console.log('[KIE AI BATCH] success', JSON.stringify({ batchName: batch.batchName, sections: batch.sections }));
      if (isCompatibilityBatch) {
        console.log('[KIE AI COMPATIBILITY] success', JSON.stringify({ attempt, sections: batch.sections }));
      }
      return { ok: true, sections: normalized, validation };
    }
    retryReason = validation.parseFailureReason || validation.errors.slice(0, 8).join(' | ') || 'batch_validation_failed';
    if (attempt < maxAttempts) {
      await persistBatchProgress(order, batch.batchName, 'kie_batch_retry', { attempt, reason: retryReason });
      console.log('[KIE AI BATCH] retry start', JSON.stringify({ batchName: batch.batchName, reason: retryReason }));
      if (isCompatibilityBatch) {
        console.log('[KIE AI COMPATIBILITY] failed', JSON.stringify({ attempt, reason: retryReason, willRetry: true }));
      }
      continue;
    }
    if (shouldSplitBatchOnValidation(batch, validation)) {
      return { ok: false, splitRecommended: true, splitReason: retryReason, validation, partialSections: normalized };
    }
    lastError = createKieBatchError('KIE AI batch validation failed', {
      batchName: batch.batchName,
      failedSections: validation.failedSections?.length ? validation.failedSections : batch.sections
    });
    if (isCompatibilityBatch) {
      console.log('[KIE AI COMPATIBILITY] failed', JSON.stringify({ attempt, reason: retryReason, willRetry: false }));
    }
    throw lastError;
  }
  if (lastValidation && shouldSplitBatchOnValidation(batch, lastValidation)) {
    return {
      ok: false,
      splitRecommended: true,
      splitReason: lastValidation.errors.join(' | ') || lastValidation.reason,
      validation: lastValidation,
      partialSections: {}
    };
  }
  throw lastError || createKieBatchError('KIE AI batch generation failed', { batchName: batch.batchName, failedSections: batch.sections });
}

async function generateKieBatchOrSplit(promptPayload, batch, endpointPath, order = null) {
  const rootBatchName = getBatchRootName(batch?.batchName || '');
  const concernFallback = () => {
    console.log('[KIE AI BATCH] concern fallback activated', JSON.stringify({ batchName: batch.batchName }));
    return { '고민에 대한 조언': buildConcernFallbackText(promptPayload) };
  };
  const throwWithPartialSections = (error, partialSections = {}, failedSections = []) => {
    const nextError = error instanceof Error ? error : createKieBatchError(String(error || 'KIE AI batch failure'), { batchName: batch.batchName });
    if (!nextError.failedStep) nextError.failedStep = 'kie_ai';
    if (!nextError.currentStep) nextError.currentStep = rootBatchName || 'kie_ai';
    if (!nextError.failedBatch) nextError.failedBatch = rootBatchName || batch.batchName;
    if (!Array.isArray(nextError.failedSections) || !nextError.failedSections.length) nextError.failedSections = failedSections.length ? failedSections : batch.sections.slice();
    if (!Number.isFinite(Number(nextError.progress))) nextError.progress = getBatchProgress(batch.batchName);
    nextError.partialSections = { ...(nextError.partialSections || {}), ...(partialSections || {}) };
    throw nextError;
  };

  let batchResult;
  try {
    batchResult = await generateKieBatch(promptPayload, batch, endpointPath, order);
  } catch (error) {
    if (rootBatchName === 'concern') return concernFallback();
    throwWithPartialSections(error, {}, Array.isArray(error?.failedSections) ? error.failedSections : batch.sections.slice());
  }

  if (batchResult?.ok) return batchResult.sections;
  if (batchResult?.splitRecommended && batch.sections.length > 1) {
    const validation = batchResult.validation || {};
    const partialSections = batchResult.partialSections || {};
    const passedSections = Array.isArray(validation.passedSections)
      ? validation.passedSections.filter((section) => String(partialSections?.[section] || '').trim())
      : [];
    const failedSections = Array.isArray(validation.failedSections) && validation.failedSections.length
      ? validation.failedSections
      : batch.sections.filter((section) => !passedSections.includes(section));
    const regenTargets = failedSections.length ? failedSections : batch.sections;
    const merged = Object.fromEntries(passedSections.map((section) => [section, partialSections[section]]));
    console.log('[KIE AI BATCH] passed sections', JSON.stringify(passedSections));
    console.log('[KIE AI BATCH] failed sections', JSON.stringify(regenTargets));
    console.log('[KIE AI BATCH] regenerate failed sections only', JSON.stringify({ batchName: batch.batchName, failedSections: regenTargets }));
    for (const section of regenTargets) {
      const singleBatch = { batchName: `${batch.batchName}:${section}`, sections: [section], parentBatchName: batch.batchName, singleSectionMode: true };
      let singleResult;
      try {
        singleResult = await generateKieBatch(promptPayload, singleBatch, endpointPath, order);
      } catch (error) {
        throwWithPartialSections(error, merged, [section]);
      }
      if (!singleResult?.ok) {
        throwWithPartialSections(createKieBatchError(`KIE AI single-section batch failed: ${section}`, {
          batchName: batch.batchName,
          failedSections: [section]
        }), merged, [section]);
      }
      Object.assign(merged, singleResult.sections || {});
    }
    return merged;
  }
  if (rootBatchName === 'concern') return concernFallback();
  throwWithPartialSections(createKieBatchError(`KIE AI batch failed: ${batch.batchName}`, {
    batchName: batch.batchName,
    failedSections: batch.sections.slice()
  }), batchResult?.partialSections || {}, batch.sections.slice());
}

function buildAiRequestBody({ style, systemPrompt, userText, outputMode, maxTokens }) {
  if (style === 'responses') {
    return {
      model: CONFIG.ai.model,
      max_output_tokens: maxTokens,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
        { role: 'user', content: [{ type: 'input_text', text: userText }] }
      ]
    };
  }
  const body = {
    model: CONFIG.ai.model,
    temperature: CONFIG.ai.temperature,
    max_tokens: maxTokens,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText }
    ]
  };
  if (outputMode === 'json') body.response_format = { type: 'json_object' };
  return body;
}

async function callAiProvider({ label, attempt, payloadMode, outputMode, systemPrompt, userText, requiredSections, endpointPathOverride = '', timeoutMs = CONFIG.ai.timeoutMs }) {
  const style = resolveAiStyle();
  const endpointPath = endpointPathOverride || resolveAiEndpointPath(style);
  const endpoint = `${CONFIG.ai.baseUrl}${endpointPath}`;
  const requestBody = buildAiRequestBody({ style, systemPrompt, userText, outputMode, maxTokens: payloadMode.maxTokens });
  const requestSize = buildAiRequestSizeSummary({ systemPrompt, userText, requestBody, payloadMode: payloadMode.mode, payloadForAi: payloadMode.payloadForAi });
  console.log(`[${label}] request start`, JSON.stringify({
    attempt,
    provider: CONFIG.ai.provider,
    model: CONFIG.ai.model,
    style,
    endpointPath,
    mode: payloadMode.mode,
    outputMode,
    maxTokens: payloadMode.maxTokens,
    timeoutMs
  }));
  console.log(`[${label}] input bundle keys`, JSON.stringify({
    basicInfo: Object.keys(payloadMode.payloadForAi?.basicInfo || {}),
    partnerInfo: Object.keys(payloadMode.payloadForAi?.partnerInfo || {}),
    topLevelKeys: Object.keys(payloadMode.payloadForAi || {}),
    requiredSections
  }));
  console.log(`[${label}] request size`, JSON.stringify(requestSize));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('kie_ai_timeout')), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.ai.apiKey}` },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    const raw = await response.text();
    console.log(`[${label}] response received`, JSON.stringify({ attempt, status: response.status, rawLength: raw.length }));
    console.log(`[${label}] raw response preview`, JSON.stringify({ attempt, status: response.status, rawLength: raw.length, preview: sanitizeKiePreviewText(raw) }));
    const upstream = detectUpstreamAiError(raw, response.status, requiredSections);
    if (!response.ok || upstream.isError) {
      const errorType = response.status >= 400
        ? 'KIE_UPSTREAM_HTTP_ERROR'
        : 'KIE_UPSTREAM_BODY_ERROR';
      console.log(`[${label}] upstream error`, JSON.stringify({
        type: errorType,
        httpStatus: response.status,
        bodyCode: upstream.bodyCode,
        bodyMessage: upstream.bodyMessage,
        endpointPath,
        model: CONFIG.ai.model,
        requestSize,
        attempt
      }));
      return {
        ok: false,
        raw,
        response,
        requestSize,
        endpointPath,
        upstreamError: {
          type: errorType,
          httpStatus: response.status,
          bodyCode: upstream.bodyCode,
          bodyMessage: upstream.bodyMessage || (!response.ok ? `HTTP ${response.status}` : 'upstream_error'),
          attempt,
          endpointPath,
          model: CONFIG.ai.model,
          requestSize,
          detectedFormat: upstream.detectedFormat || 'unknown'
        }
      };
    }
    return { ok: true, raw, response, requestSize, endpointPath };
  } catch (error) {
    const message = error?.name === 'AbortError' || String(error?.message || '').includes('kie_ai_timeout') ? 'kie_ai_timeout' : (error.message || 'unknown');
    console.log(`[${label}] transport error`, JSON.stringify({ attempt, endpointPath, type: error?.name || 'Error', message, timeoutMs }));
    return {
      ok: false,
      error,
      requestSize,
      endpointPath,
      upstreamError: {
        type: 'KIE_TRANSPORT_ERROR',
        httpStatus: 0,
        bodyCode: 'transport_error',
        bodyMessage: message,
        attempt,
        endpointPath,
        model: CONFIG.ai.model,
        requestSize,
        detectedFormat: 'transport_error'
      }
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildSmokePromptPayload() {
  const requiredSections = buildRequiredAiSections(true);
  return {
    basicInfo: {
      name: '테스트 사용자',
      gender: 'male',
      birthYear: '1996',
      birthMonth: '07',
      birthDay: '03',
      birthTime: '15:00',
      calendarType: '양력',
      baselineDate: '2026-06-01',
      concern: '온라인 사주 사업을 준비중인데 잘 될까요?'
    },
    partnerInfo: {
      name: '테스트 상대',
      gender: 'female',
      birthYear: '1995',
      birthMonth: '05',
      birthDay: '14',
      birthTime: '21:45',
      calendarType: '양력'
    },
    chartData: {
      pillars: { year: '병자', month: '갑오', day: '무술', hour: '경신' },
      pillarDetails: { year: { gan: '병', ji: '자' }, month: { gan: '갑', ji: '오' }, day: { gan: '무', ji: '술' }, hour: { gan: '경', ji: '신' } },
      fiveElements: { 목: 22, 화: 27, 토: 24, 금: 15, 수: 12 },
      tenGods: { 비견: 14, 식신: 12, 정재: 10, 편관: 11 },
      strength: '중화에 가까우나 화와 토가 상대적으로 강합니다.',
      yongsin: '수와 금의 균형 보강이 중요합니다.',
      johu: '화기 조절과 수기 보완이 필요합니다.',
      daeun: [{ ageRange: '31-40', summary: '사업 확장과 구조 정비가 함께 들어오는 흐름' }],
      futureFiveYears: [{ year: '2026', summary: '준비한 서비스를 구체화하기 좋은 해' }],
      futureSixMonths: [{ year: '2026', month: '07', summary: '상품 구조를 다듬기 좋은 달' }],
      compatibility: { summary: '서로의 생활 속도는 다르지만 역할 분담이 되면 안정적입니다.' }
    },
    rawBundle: {
      mansae: { sample: true },
      saju: { sample: true },
      period: { sample: true },
      compatibility: { sample: true }
    },
    internalReference: {
      consistencyWarnings: [],
      compatibilityRequested: true,
      requiredSections
    }
  };
}

async function runKieSmokeTest(mode = 'smoke', candidate = 'all') {
  if (!CONFIG.ai.apiKey) {
    return { ok: false, mode, candidate, error: 'AI API key missing' };
  }
  const style = resolveAiStyle();
  const allCandidates = getAiEndpointCandidates(style);
  const selectedCandidates = candidate === 'configured'
    ? [allCandidates[0]]
    : candidate === 'market'
      ? allCandidates.filter((path) => path.includes(`/${CONFIG.ai.model}/`)).slice(0, 1)
      : candidate === 'openai'
        ? allCandidates.filter((path) => /\/v1\/(chat\/completions|responses)$/.test(path)).slice(-1)
        : allCandidates;

  const promptPayload = buildSmokePromptPayload();
  const fullSections = buildRequiredAiSections(true);
  const smokeSections = ['핵심 요약', '사주 원국 해석', '대운', '고민에 대한 조언', '관계/궁합 해석'];
  const tests = [];

  for (const endpointPath of selectedCandidates) {
    if (mode === 'smoke') {
      const systemPrompt = '당신은 JSON만 반환하는 응답기입니다. 반드시 {"ok":true,"message":"pong"}만 반환하세요.';
      const userText = 'JSON으로 {"ok":true,"message":"pong"} 만 반환하세요.';
      const payloadMode = { mode: 'smoke', maxTokens: 200, payloadForAi: { smoke: true } };
      console.log('[KIE SMOKE] request start', JSON.stringify({ mode, endpointPath }));
      const result = await callAiProvider({ label: 'KIE SMOKE', attempt: 1, payloadMode, outputMode: 'json', systemPrompt, userText, requiredSections: [], endpointPathOverride: endpointPath });
      if (!result.ok) {
        console.log('[KIE SMOKE] endpointPath', endpointPath);
        console.log('[KIE SMOKE] status', JSON.stringify({ ok: false, endpointPath, upstreamError: result.upstreamError }));
        tests.push({ ok: false, endpointPath, ...result.upstreamError });
        continue;
      }
      const parsed = tryParseJsonText(result.raw);
      const nestedText = extractTextFromMessageContent(parsed?.choices?.[0]?.message?.content)
        || extractResponsesText(parsed)
        || '';
      const nestedParsed = tryParseJsonText(nestedText);
      const effectiveParsed = nestedParsed && typeof nestedParsed === 'object' ? nestedParsed : parsed;
      const ok = effectiveParsed?.ok === true && effectiveParsed?.message === 'pong';
      console.log('[KIE SMOKE] endpointPath', endpointPath);
      console.log('[KIE SMOKE] status', JSON.stringify({ ok, endpointPath, status: result.response.status }));
      console.log('[KIE SMOKE] body preview', JSON.stringify({ endpointPath, preview: sanitizeKiePreviewText(result.raw) }));
      tests.push({ ok, endpointPath, status: result.response.status, preview: sanitizeKiePreviewText(result.raw), parsed: effectiveParsed });
      continue;
    }

    const requiredSections = mode === 'compact_report' ? smokeSections : fullSections;
    const payloadForAi = buildAiPayloadForMode(promptPayload, requiredSections, mode === 'compact_report' ? 'compact_report' : 'full_report');
    const systemPrompt = [
      '당신은 숙련된 한국어 사주 해석 상담사입니다.',
      mode === 'compact_report'
        ? '반드시 JSON 객체만 반환하고, 아래 필수 섹션 5개만 작성하세요.'
        : '반드시 JSON 객체만 반환하고, 아래 필수 섹션을 모두 작성하세요.',
      '마크다운, 코드블록, 설명문을 금지합니다.'
    ].join(' ');
    const userText = JSON.stringify({ requiredSections, promptPayload: payloadForAi });
    const payloadMode = { mode, maxTokens: mode === 'compact_report' ? 2500 : 5000, payloadForAi };
    console.log('[KIE SMOKE] request start', JSON.stringify({ mode, endpointPath }));
    const result = await callAiProvider({ label: 'KIE SMOKE', attempt: 1, payloadMode, outputMode: 'json', systemPrompt, userText, requiredSections, endpointPathOverride: endpointPath });
    if (!result.ok) {
      console.log('[KIE SMOKE] endpointPath', endpointPath);
      console.log('[KIE SMOKE] status', JSON.stringify({ ok: false, endpointPath, upstreamError: result.upstreamError }));
      tests.push({ ok: false, endpointPath, ...result.upstreamError });
      continue;
    }
    const parsedMeta = parseKieSectionMap(result.raw, requiredSections);
    const validation = validateAiSections(parsedMeta.sections || {}, { ...promptPayload, chartData: promptPayload.chartData, partnerInfo: promptPayload.partnerInfo }, parsedMeta, {
      requiredSections,
      enforceTotalLength: true,
      requireJsonOnly: true
    });
    console.log('[KIE SMOKE] endpointPath', endpointPath);
    console.log('[KIE SMOKE] status', JSON.stringify({ ok: validation.ok, endpointPath, status: result.response.status }));
    console.log('[KIE SMOKE] body preview', JSON.stringify({ endpointPath, preview: sanitizeKiePreviewText(result.raw) }));
    tests.push({ ok: validation.ok, endpointPath, status: result.response.status, detectedFormat: parsedMeta.detectedFormat, preview: sanitizeKiePreviewText(result.raw), validation });
  }

  const winner = tests.find((item) => item.ok) || null;
  return { ok: Boolean(winner), mode, candidate, configuredEndpointPath: allCandidates[0], tests, winner };
}

async function generateAiSections(promptPayload, order = null) {
  if (!CONFIG.ai.apiKey) {
    if (CONFIG.allowLocalFallback) {
      console.log('[KIE AI FINAL] AI API key missing, using local fallback sections');
      return fallbackAiSections({
        ...promptPayload,
        applicant: promptPayload?.basicInfo || promptPayload?.applicant || {},
        partner: promptPayload?.partnerInfo || promptPayload?.partner || null
      });
    }
    throw createKieBatchError('AI API 키가 설정되지 않았습니다.');
  }
  const hasCompatibility = hasCompatibilityPromptPayload(promptPayload);
  const endpointPath = resolveAiEndpointPath(resolveAiStyle());
  const batches = getReportBatches(hasCompatibility);
  const finalSections = {};
  const waves = buildBatchWaves(batches);

  for (const wave of waves) {
    if (order) {
      updateOrderProgress(order, {
        status: 'generating',
        currentStep: 'kie_ai',
        progress: Math.max(getOrderProgress(order), getDefaultProgressForStep('kie_ai')),
        failedStep: null,
        failedBatch: null,
        failedSections: [],
        statusMessage: buildGeneratingMessage('kie_ai')
      });
      order.logs.push(logLine('kie_wave_start', { batches: wave.map((batch) => batch.batchName) }));
      await saveOrder(order);
    }

    const settled = await Promise.allSettled(
      wave.map(async (batch) => {
        const sections = await generateKieBatchOrSplit(promptPayload, batch, endpointPath, order);
        return { batch, sections };
      })
    );

    const failures = [];
    for (let index = 0; index < settled.length; index += 1) {
      const batch = wave[index];
      const result = settled[index];
      if (result.status === 'fulfilled') {
        const sections = postProcessReportSections(promptPayload, result.value.sections || {});
        Object.assign(finalSections, sections);
        await persistBatchProgress(order, batch.batchName, 'kie_batch_success', {
          sections: Object.keys(sections),
          lengths: summarizeSectionLengths(sections, batch.sections)
        });
      } else {
        const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason || 'unknown'));
        if (error.partialSections && typeof error.partialSections === 'object' && Object.keys(error.partialSections).length) {
          const preservedSections = postProcessReportSections(promptPayload, error.partialSections);
          Object.assign(finalSections, preservedSections);
          console.log('[KIE AI BATCH] preserved completed sections after partial failure', JSON.stringify({
            batchName: batch.batchName,
            preservedSections: Object.keys(preservedSections),
            failedSections: error.failedSections || []
          }));
        }
        failures.push({ batch, error });
      }
    }

    if (order) {
      order.artifacts = order.artifacts || {};
      order.artifacts.partialAiSections = { ...finalSections };
      await saveOrder(order);
    }

    if (failures.length) {
      const firstFailure = failures.sort((a, b) => wave.indexOf(a.batch) - wave.indexOf(b.batch))[0];
      const error = firstFailure.error;
      if (!error.failedStep) error.failedStep = 'kie_ai';
      if (!error.currentStep) error.currentStep = getBatchRootName(firstFailure.batch.batchName);
      if (!error.failedBatch) error.failedBatch = getBatchRootName(firstFailure.batch.batchName);
      if (!Array.isArray(error.failedSections) || !error.failedSections.length) {
        error.failedSections = Array.isArray(firstFailure.error?.failedSections) && firstFailure.error.failedSections.length
          ? Array.from(new Set(firstFailure.error.failedSections.filter(Boolean)))
          : firstFailure.batch.sections.slice();
      }
      if (!Number.isFinite(Number(error.progress))) error.progress = getBatchProgress(firstFailure.batch.batchName);
      throw error;
    }
  }

  const requiredSections = buildRequiredAiSections(hasCompatibility);
  const totalLength = requiredSections.reduce((sum, key) => sum + countVisibleChars(finalSections[key] || ''), 0);
  console.log('[KIE AI FINAL] merged section keys', JSON.stringify(Object.keys(finalSections)));
  console.log('[KIE AI FINAL] total length', JSON.stringify({ totalLength, requiredSections }));
  const processedFinalSections = postProcessReportSections(promptPayload, finalSections);
  const finalValidation = validateSectionMap(processedFinalSections, promptPayload, {
    rawLength: totalLength,
    detectedFormat: 'merged_sections',
    sourcePath: 'batch_merge'
  }, {
    requiredSections,
    enforceTotalLength: true,
    requireRawLength: false
  });
  console.log('[KIE AI FINAL] validation result', JSON.stringify(finalValidation));
  if (!finalValidation.ok) {
    const failedSections = Array.isArray(finalValidation.failedSections) ? Array.from(new Set(finalValidation.failedSections.filter(Boolean))) : [];
    throw createKieBatchError('KIE AI final validation failed', {
      batchName: 'final_validation',
      failedBatch: 'final_validation',
      failedStep: 'final_validation',
      currentStep: 'final_validation',
      progress: getBatchProgress('html_render'),
      failedSections,
      userMessage: '리포트 해석 생성 단계에서 일시적인 문제가 발생했습니다. 잠시 후 다시 확인해 주세요.'
    });
  }
  return processedFinalSections;
}


function buildConcernFallbackText(promptPayload) {
  const applicantInfo = promptPayload?.basicInfo || promptPayload?.applicant || {};
  const name = stripHonorificSuffix(applicantInfo.name || '') || '고객';
  const concern = String(applicantInfo.concern || '현재 삶의 방향').trim();
  return [
    `${name}님이 적어주신 고민인 "${concern}"은 단순히 운의 좋고 나쁨만으로 결론을 내리기보다, 지금 어떤 기준으로 선택하고 어떤 순서로 움직일지 정하는 일이 더 중요합니다. 사주에서는 타고난 성향과 현재 흐름을 함께 보는데, 쉽게 말하면 지금은 결과를 서두르기보다 방향과 우선순위를 먼저 정리할수록 흔들림이 줄어들 수 있는 시기입니다.`,
    `${name}님에게 필요한 핵심은 한 번에 모든 문제를 해결하려는 방식보다, 가장 체감이 큰 한 가지를 먼저 정하고 그것과 연결된 일정·관계·지출을 함께 점검하는 접근입니다. 실제 생활에서는 해야 할 일이 많을수록 오히려 판단이 늦어지거나, 반대로 급하게 결론을 내리고 나중에 다시 수정하는 형태로 나타날 수 있습니다. 그래서 중요한 선택일수록 오늘 바로 결정할 일과 조금 더 확인할 일을 분리하는 기준이 필요합니다.`,
    `주의할 점은 불안이 커질 때 주변 말에 쉽게 흔들리거나, 반대로 혼자 감당하려는 마음이 강해질 수 있다는 점입니다. 특히 고민이 일이나 진로, 돈, 관계와 연결되어 있다면 겉으로 좋아 보이는 제안보다 실제로 오래 유지할 수 있는 구조인지 먼저 확인하는 태도가 필요합니다. 단정적으로 좋다 나쁘다를 나누기보다, 지금의 선택이 다음 한두 달 뒤에도 감당 가능한지 살펴보는 것이 더 현실적인 기준이 됩니다.`,
    `실천 조언으로는 첫째, 고민과 관련된 선택지를 종이에 두세 개만 적고 각각의 장단점을 짧게 비교해 보시길 권합니다. 둘째, 이번 주 안에 바로 실행할 행동 한 가지와 보류할 행동 한 가지를 나눠서 일정에 넣어 보시면 좋습니다. 셋째, 중요한 결정은 혼자 오래 끌지 말고 믿을 수 있는 사람에게 현재 상황과 원하는 결과를 짧게 설명한 뒤 피드백을 받아 보시는 것이 도움이 됩니다.`,
    `정리하면, ${name}님의 고민은 운세의 단정적인 결론보다 지금 무엇을 먼저 정리하고 어디에 힘을 모아야 하는지에 대한 문제에 가깝습니다. 서두르지 않고 기준을 세운 뒤 한 단계씩 움직이면 불안은 줄이고 선택의 정확도는 높일 수 있습니다. 지금은 큰 결심 하나보다 작더라도 계속 이어갈 수 있는 행동 기준을 만드는 것이 가장 중요합니다.`
  ].join('\n\n');
}

function fallbackAiSections(promptPayload) {
  const applicantInfo = promptPayload?.basicInfo || promptPayload?.applicant || {};
  const partnerInfo = promptPayload?.partnerInfo || promptPayload?.partner || null;
  const name = stripHonorificSuffix(applicantInfo.name || '') || '고객';
  const concern = applicantInfo.concern || '현재 삶의 방향';
  const birthTimeUnknown = applicantInfo.birthTimeUnknown === true || promptPayload?.analysisNotes?.birthTimeUnknown === true;
  const hasCompatibility = Boolean(promptPayload.compatibilityReference || hasPartnerCoreFields(partnerInfo));
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
    '고민에 대한 조언': buildConcernFallbackText(promptPayload)
  };
  if (birthTimeUnknown) {
    sections['사주 원국 해석'] = `${sections['사주 원국 해석']} 출생시간이 확인되지 않아 시주를 기준으로 한 일부 세부 해석은 제한적으로 참고하는 것이 좋습니다.`;
    sections['자녀운'] = `${sections['자녀운']} 출생시간이 확인되지 않은 경우 자녀운과 말년운 해석은 참고용으로만 보시는 것이 좋습니다.`;
    sections['주의할 점'] = `${sections['주의할 점']} 출생시간 미상인 경우 시간대에 민감한 해석은 단정적으로 받아들이지 않는 것이 좋습니다.`;
  }
  if (hasCompatibility) {
    sections['관계/궁합 해석'] = `두 사람의 궁합은 단순한 좋고 나쁨보다 서로가 관계에서 어떤 안정감을 원하는지, 갈등이 생겼을 때 어떻게 회복하는지가 핵심입니다. 서로의 속도와 표현 방식이 다를 수 있으므로, 감정을 추측하기보다 말과 행동의 기준을 맞추는 과정이 중요합니다. 상대에 대한 기대가 커질수록 실망도 커질 수 있으니, 관계의 방향을 천천히 확인하면서 신뢰를 쌓아가세요.`;
  }
  return postProcessReportSections(promptPayload, sections);
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

function resolvePublicBaseUrl(req = null, order = null) {
  const orderBaseUrl = String(order?.publicBaseUrl || '').trim().replace(/\/$/, '');
  if (orderBaseUrl) return orderBaseUrl;
  if (EXPLICIT_BASE_URL) return EXPLICIT_BASE_URL;
  if (req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
    const forwardedHost = String(req.headers['x-forwarded-host'] || req.get?.('host') || '').split(',')[0].trim();
    if (forwardedHost) return `${forwardedProto}://${forwardedHost}`.replace(/\/$/, '');
  }
  return BASE_URL;
}

function assertLivePaymentBaseUrl(publicBaseUrl) {
  const normalized = String(publicBaseUrl || '').trim();
  if (CONFIG.payapp.mock) return;
  if (!/^https:\/\//i.test(normalized)) {
    throw new Error('실제 결제 모드에서는 BASE_URL 또는 SITE_URL을 https 공개 주소로 설정해야 합니다.');
  }
  if (/^https:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(normalized)) {
    throw new Error('실제 결제 모드에서는 localhost 주소를 사용할 수 없습니다. BASE_URL 또는 SITE_URL을 Render 도메인으로 설정해 주세요.');
  }
}

function buildOrderStatusPageUrl(orderId, publicBaseUrl = BASE_URL) {
  return `${String(publicBaseUrl || BASE_URL).replace(/\/$/, '')}/report-status.html?orderId=${encodeURIComponent(orderId)}`;
}

function cloneRuntimeOrder(order) {
  return order ? JSON.parse(JSON.stringify(order)) : null;
}

async function saveOrder(order) {
  order.updatedAt = new Date().toISOString();
  runtimeOrderStore.set(order.id, cloneRuntimeOrder(order));
}

async function readOrder(orderId) {
  return cloneRuntimeOrder(runtimeOrderStore.get(orderId) || null);
}

async function appendLog(name, payload) {
  console.log(`[APP LOG] ${name}`, JSON.stringify(payload || {}));
}

async function ensureDirectories() {
  return true;
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
