import http from 'node:http';
import fsSync from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { calculateFourPillars, lunarToSolar } from 'manseryeok';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');

loadEnv(path.join(ROOT_DIR, '.env'));

const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const PREMIUM_PRICE = Number(process.env.PREMIUM_PRICE || 19000);
const SAJU_PROVIDER = (process.env.SAJU_PROVIDER || 'luckyloveme').toLowerCase();
const LUCKYLOVEME_API_BASE = process.env.LUCKYLOVEME_API_BASE || 'https://luckyloveme.com';
const LUCKYLOVEME_MANSAE_URL = process.env.LUCKYLOVEME_MANSAE_URL || `${LUCKYLOVEME_API_BASE}/api/mansae`;
const LUCKYLOVEME_API_KEY = process.env.LUCKYLOVEME_API_KEY || process.env.X_SAJU_BOOK_API_KEY || '';
const KST_STANDARD_MERIDIAN = 135;
const SEOUL_LONGITUDE = 126.9780;
const SEOUL_LOCAL_SOLAR_OFFSET_MINUTES = Math.round((SEOUL_LONGITUDE - KST_STANDARD_MERIDIAN) * 4);
const FORTUNETELLER_REPO_DIR = process.env.FORTUNETELLER_REPO_DIR || path.join(ROOT_DIR, 'fortuneteller_repo');
const FORTUNETELLER_TSX = path.join(
  FORTUNETELLER_REPO_DIR,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx'
);

await ensureStorage();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, APP_BASE_URL);

    if (req.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'pogeun-saju-live-starter',
        sajuProvider: SAJU_PROVIDER,
        payappReady: hasPayAppCredentials(),
        time: new Date().toISOString()
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/saju/summary') {
      const body = await readJsonBody(req);
      return handleSajuSummary(res, body);
    }

    if (req.method === 'POST' && url.pathname === '/api/pay/request') {
      const body = await readJsonBody(req);
      return handlePayRequest(res, body);
    }

    if (req.method === 'POST' && url.pathname === '/api/pay/feedback') {
      const form = await readFormBody(req);
      return handlePayFeedback(res, form);
    }

    if (req.method === 'GET' && url.pathname === '/api/order-status') {
      const orderId = url.searchParams.get('orderId');
      if (!orderId) return sendJson(res, 400, { error: 'orderId is required' });
      const order = await getOrder(orderId);
      if (!order) return sendJson(res, 404, { error: 'order not found' });
      return sendJson(res, 200, { order });
    }

    if (req.method === 'GET' && url.pathname === '/payment/return') {
      const orderId = url.searchParams.get('orderId') || '';
      const order = orderId ? await getOrder(orderId) : null;
      return sendHtml(res, 200, renderPaymentReturnPage(order));
    }

    if (req.method === 'GET' && url.pathname === '/report/view') {
      const orderId = url.searchParams.get('orderId') || '';
      const order = orderId ? await getOrder(orderId) : null;
      return sendHtml(res, 200, renderReportGatePage(order));
    }

    if (req.method === 'GET') {
      return serveStaticFile(res, url.pathname);
    }

    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, {
      error: 'Internal server error',
      message: error instanceof Error ? error.message : String(error)
    });
  }
});

server.listen(PORT, () => {
  console.log(`다온사주 개발 서버가 실행되었습니다: ${APP_BASE_URL}`);
});

async function handleSajuSummary(res, body) {
  const payload = normalizeUserInput(body);

  if (!payload.birthDate) return sendJson(res, 400, { error: 'birthDate is required' });
  if (!payload.birthTime) return sendJson(res, 400, { error: 'birthTime is required' });
  if (!['solar', 'lunar'].includes(payload.calendar)) return sendJson(res, 400, { error: 'calendar must be solar or lunar' });
  if (!['male', 'female'].includes(payload.gender)) {
    return sendJson(res, 400, { error: '실제 사주 계산 연동은 현재 남성/여성 입력만 지원합니다.' });
  }

  let result;
  if (SAJU_PROVIDER === 'mock') {
    result = buildMockSummary(payload, { provider: 'mock' });
  } else if (SAJU_PROVIDER === 'manseryeok') {
    try {
      result = analyzeWithManseryeok(payload);
    } catch (error) {
      console.error('manseryeok error:', error);
      result = buildMockSummary(payload, { provider: 'mock-fallback' });
      result.notice = 'manseryeok 계산 중 오류가 발생해 임시 요약으로 대체되었습니다.';
    }
  } else {
    try {
      result = await analyzeWithLuckyLovemeMansae(payload);
    } catch (error) {
      console.error('luckyloveme mansae error:', error);
      result = buildMockSummary(payload, { provider: 'mock-fallback' });
      result.notice = '만세력 API 계산 중 오류가 발생해 임시 요약으로 대체되었습니다.';
    }
  }

  return sendJson(res, 200, { result });
}

async function handlePayRequest(res, body) {
  if (!hasPayAppCredentials()) {
    return sendJson(res, 400, {
      error: 'PayApp 설정이 완료되지 않았습니다.',
      missing: missingPayAppEnvKeys()
    });
  }

  const orderId = body.orderId || crypto.randomUUID();
  const recvphone = String(body.recvphone || '').replace(/[^0-9]/g, '');
  const price = Number(body.price || PREMIUM_PRICE);
  const goodname = String(body.goodname || '다온사주 프리미엄 리포트');

  if (!recvphone) return sendJson(res, 400, { error: 'recvphone is required' });
  if (!Number.isFinite(price) || price < 1000) {
    return sendJson(res, 400, { error: 'price must be at least 1000 KRW' });
  }

  const orderRecord = {
    orderId,
    status: 'payment_requested',
    createdAt: new Date().toISOString(),
    goodname,
    price,
    recvphone,
    customer: normalizeUserInput(body.customer || {}),
    summarySnapshot: body.summarySnapshot || null,
    payapp: null
  };

  await upsertOrder(orderRecord);

  const payappResult = await requestPayAppPayment(orderRecord);
  if (!payappResult.ok) {
    await patchOrder(orderId, {
      status: 'payment_request_failed',
      payapp: { raw: payappResult.raw, error: payappResult.message }
    });
    return sendJson(res, 502, {
      error: 'PayApp 결제요청에 실패했습니다.',
      detail: payappResult.message,
      raw: payappResult.raw
    });
  }

  await patchOrder(orderId, {
    status: 'payment_page_ready',
    payapp: payappResult.data
  });

  return sendJson(res, 200, {
    orderId,
    payurl: payappResult.data.payurl,
    mul_no: payappResult.data.mul_no,
    returnurl: `${APP_BASE_URL}/payment/return?orderId=${encodeURIComponent(orderId)}`
  });
}

async function handlePayFeedback(res, form) {
  const orderId = form.var1 || form.var2 || '';
  const order = orderId ? await getOrder(orderId) : null;
  if (!order) {
    return sendText(res, 404, 'INVALID');
  }

  const paidPrice = Number(form.price || 0);
  const isValid =
    form.userid === process.env.PAYAPP_USERID &&
    form.linkkey === process.env.PAYAPP_LINKKEY &&
    form.linkval === process.env.PAYAPP_LINKVAL &&
    paidPrice === Number(order.price);

  if (!isValid) {
    await patchOrder(order.orderId, {
      status: 'payment_callback_invalid',
      payappCallback: form,
      updatedAt: new Date().toISOString()
    });
    return sendText(res, 400, 'INVALID');
  }

  await patchOrder(order.orderId, {
    status: 'paid',
    paidAt: new Date().toISOString(),
    payappCallback: form,
    updatedAt: new Date().toISOString()
  });

  return sendText(res, 200, 'SUCCESS');
}

async function analyzeWithLuckyLovemeMansae(payload) {
  const [birthYear, birthMonth, birthDay] = String(payload.birthDate || '').split('-');
  const [birthHour, birthMinute] = String(payload.birthTime || '00:00').split(':');

  const requestBody = {
    year: String(Number(birthYear || 0)),
    month: String(Number(birthMonth || 0)),
    day: String(Number(birthDay || 0)),
    birthHour: String(Number(birthHour || 0)),
    birthMinute: String(Number(birthMinute || 0)),
    calendarType: payload.calendar === 'lunar' ? '음력' : '양력',
    isLeapMonth: Boolean(payload.isLeapMonth)
  };

  const headers = { 'content-type': 'application/json' };
  if (LUCKYLOVEME_API_KEY) headers['X-SAJU-BOOK-API-KEY'] = LUCKYLOVEME_API_KEY;

  const response = await fetch(LUCKYLOVEME_MANSAE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.message === 'Invalid API key') {
    throw new Error(data?.message || `HTTP ${response.status}`);
  }

  return normalizeLuckyLovemeMansaeResult(data, payload);
}

function normalizeLuckyLovemeMansaeResult(apiData, payload) {
  const fallback = buildMockSummary(payload, { provider: 'mock-fallback' });
  const name = payload?.name || '사용자';
  const fullData = apiData?.fullData || {};

  const pillarDetails = {
    year: normalizeLuckyLovemePillar(fullData?.year),
    month: normalizeLuckyLovemePillar(fullData?.month),
    day: normalizeLuckyLovemePillar(fullData?.day),
    hour: normalizeLuckyLovemePillar(apiData?.hourGanji)
  };

  const dayPillar = pillarDetails.day;
  const monthPillar = pillarDetails.month;
  const yearPillar = pillarDetails.year;
  const hourPillar = pillarDetails.hour;

  const tags = [
    dayPillar?.ohaeng?.gan ? `${dayPillar.ohaeng.gan} 기운` : '',
    monthPillar?.ohaeng?.ji ? `${monthPillar.ohaeng.ji} 기운` : '',
    dayPillar?.sipseong?.ji ? `${dayPillar.sipseong.ji} 관계 포인트` : '',
    apiData?.birthInfo?.calendarType || ''
  ].filter(Boolean).slice(0, 4);

  const result = {
    provider: 'luckyloveme',
    year: pillarDetails.year?.hangul || fallback.year,
    month: pillarDetails.month?.hangul || fallback.month,
    day: pillarDetails.day?.hangul || fallback.day,
    hour: pillarDetails.hour?.hangul || '',
    pillarDetails,
    tags: tags.length ? tags : fallback.tags,
    summary: `${name}님의 일주는 ${dayPillar?.hangul || fallback.day}(${dayPillar?.hanja || pillarToHanja(dayPillar?.hangul || fallback.day)})이며, ${dayPillar?.ohaeng?.gan || '핵심'} 기운이 중심으로 읽힙니다. ${monthPillar?.hangul || fallback.month}의 흐름이 함께 작용해 전체적으로 ${monthPillar?.ohaeng?.ji || '보조'} 기운의 현실감과 ${dayPillar?.eumyang?.gan || '기본'}의 리듬이 드러납니다.`,
    trait: `${dayPillar?.sipseong?.gan || '일간'}과 ${dayPillar?.sipseong?.ji || '지지'}의 조합상, 처음에는 신중하게 상황을 살피지만 방향을 정하면 꾸준히 밀고 가는 힘이 있는 타입으로 볼 수 있습니다.`,
    love: `관계에서는 ${dayPillar?.eumyang?.gan || '기본'} 성향과 ${dayPillar?.sipseong?.ji || '관계'} 포인트가 함께 드러납니다. 편안함과 신뢰를 쌓을수록 본래의 매력이 더 자연스럽게 표현됩니다.`,
    work: `일과 재물에서는 ${monthPillar?.ohaeng?.gan || '월주'}와 ${yearPillar?.ohaeng?.ji || '연주'} 흐름이 같이 작동합니다. 급하게 넓히기보다 기준을 세우고 구조를 쌓아갈수록 안정감이 커집니다.`,
    mansaeMeta: {
      ganji: apiData?.ganji || '',
      solar: fullData?.양력 || '',
      lunar: fullData?.음력 || '',
      dayOfWeek: fullData?.dayOfWeek || '',
      julianDate: fullData?.julianDate || '',
      jasiType: apiData?.jasiType || 'none'
    }
  };

  result.ui = buildUiModel(result, payload, {
    intro: `${name}님의 만세력 API 결과를 바탕으로 네 기둥의 천간·지지, 음양, 오행, 십성을 한 화면에서 볼 수 있게 정리했습니다.`,
    advice: `${dayPillar?.ohaeng?.gan || '핵심'} 기운이 살아나는 선택과 ${monthPillar?.sipseong?.gan || '흐름'}의 장점을 살리는 방향으로 리듬을 잡아보세요.`
  });
  return result;
}

function normalizeLuckyLovemePillar(pillar) {
  if (!pillar) return null;
  return {
    hangul: pillar.hangul || '',
    hanja: pillar.hanja || '',
    eumyang: pillar.eumyang || { gan: '', ji: '' },
    ohaeng: pillar.ohaeng || { gan: '', ji: '' },
    sipseong: pillar.sipseong || { gan: '', ji: '' }
  };
}

async function analyzeWithFortuneteller(payload) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js')
  ]);

  const useLocalRepo = fsSync.existsSync(FORTUNETELLER_TSX);
  const transport = new StdioClientTransport({
    command: useLocalRepo ? FORTUNETELLER_TSX : process.platform === 'win32' ? 'npx.cmd' : 'npx',
    args: useLocalRepo ? ['src/index.ts'] : ['-y', 'saju-mcp-server'],
    cwd: useLocalRepo ? FORTUNETELLER_REPO_DIR : ROOT_DIR,
    env: { ...process.env },
    stderr: 'inherit'
  });

  const client = new Client({ name: 'pogeun-saju-web', version: '1.0.0' });
  await client.connect(transport);

  try {
    const toolResult = await client.callTool({
      name: 'analyze_saju',
      arguments: {
        birthDate: payload.birthDate,
        birthTime: payload.birthTime,
        calendar: payload.calendar,
        isLeapMonth: payload.isLeapMonth,
        gender: payload.gender,
        analysisType: 'basic'
      }
    });

    return normalizeFortunetellerToolResult(toolResult, payload);
  } finally {
    try {
      if (typeof client.close === 'function') await client.close();
    } catch {}
    try {
      if (typeof transport.close === 'function') await transport.close();
    } catch {}
  }
}

function normalizeFortunetellerToolResult(toolResult, payload) {
  const fallback = buildMockSummary(payload, { provider: 'mock-fallback' });
  const text = extractTextFromToolResult(toolResult);
  const parsed = tryParseJson(text);

  const fourPillars =
    parsed?.fourPillars ||
    parsed?.saju?.fourPillars ||
    parsed?.data?.fourPillars ||
    parsed?.pillars ||
    (parsed?.year || parsed?.month || parsed?.day || parsed?.hour
      ? {
          year: parsed?.year,
          month: parsed?.month,
          day: parsed?.day,
          hour: parsed?.hour
        }
      : {});

  const tags = buildTagsFromParsed(parsed, fallback.tags);

  const result = {
    provider: 'fortuneteller',
    year: pillarString(fourPillars.year || fourPillars.yearPillar) || fallback.year,
    month: pillarString(fourPillars.month || fourPillars.monthPillar) || fallback.month,
    day: pillarString(fourPillars.day || fourPillars.dayPillar) || fallback.day,
    hour: pillarString(fourPillars.hour || fourPillars.hourPillar) || fallback.hour,
    tags,
    summary:
      pickFirst(
        parsed?.summary,
        parsed?.analysis?.summary,
        parsed?.interpretation?.summary,
        parsed?.saju?.summary
      ) || fallback.summary,
    trait:
      pickFirst(
        parsed?.personality,
        parsed?.analysis?.personality,
        parsed?.character,
        parsed?.traits,
        parsed?.strengths
      ) || fallback.trait,
    love:
      pickFirst(
        parsed?.love,
        parsed?.relationship,
        parsed?.analysis?.love,
        parsed?.analysis?.relationship,
        parsed?.romance
      ) || fallback.love,
    work:
      pickFirst(
        parsed?.career,
        parsed?.wealth,
        parsed?.work,
        parsed?.money,
        parsed?.analysis?.career,
        parsed?.analysis?.wealth
      ) || fallback.work,
    rawText: text
  };

  result.ui = buildUiModel(result, payload, parsed);
  return result;
}

function analyzeWithManseryeok(payload) {
  const input = convertToManseryeokInput(payload);
  const fourPillars = calculateFourPillars(input);
  const pillars = fourPillars.toObject();
  const pillarsHanja = fourPillars.toHanjaObject();
  const dayElement = fourPillars.dayElement || {};
  const dayYinYang = fourPillars.dayYinYang || {};
  const name = payload.name || '사용자';
  const correctedClock = formatClock(input.hour, input.minute);
  const correctedDate = formatDateParts(input.year, input.month, input.day);
  const correctionText = `${Math.abs(input.correctionMinutes)}분`;

  const result = {
    provider: 'manseryeok',
    year: pillars?.year || '',
    month: pillars?.month || '',
    day: pillars?.day || '',
    hour: pillars?.hour || '',
    tags: buildManseryeokTags({ pillars, pillarsHanja, dayElement, dayYinYang, payload, input }),
    summary: `${name}님의 일주는 ${pillars?.day || '-'}(${pillarsHanja?.day?.hanja || '-'})이며, ${dayElement?.stem || '기본'} 기운이 중심축으로 읽힙니다. 서울 기준 지역시 보정 ${correctionText}을 적용해 ${correctedDate} ${correctedClock}로 계산했고, ${dayYinYang?.stem === '양' ? '바깥으로 밀고 나가는 추진력' : '안쪽에서 다지는 안정감'}이 함께 드러나는 흐름입니다.`,
    trait: `${dayElement?.stem || '핵심'} 기운과 ${dayElement?.branch || '보조'} 기운이 같이 작동해, 처음에는 신중하게 상황을 살피지만 방향이 정해지면 꾸준히 밀고 가는 성향으로 읽힙니다.`,
    love: `관계에서는 ${dayYinYang?.stem || '기본'} 성향이 뚜렷해 감정 표현의 속도와 거리 조절이 중요합니다. 편안함과 신뢰가 쌓일수록 본래의 매력이 더 자연스럽게 드러나는 타입입니다.`,
    work: `일과 재물에서는 ${pillars?.month || '월주'}와 ${pillars?.year || '연주'}의 흐름이 함께 작동해, 급하게 확장하기보다 기준을 세우고 구조를 쌓아갈수록 안정감이 커집니다.`,
    pillarDetails: buildFallbackPillarDetails({ year: pillars?.year || '', month: pillars?.month || '', day: pillars?.day || '', hour: pillars?.hour || '' }),
    localSolar: {
      standardMeridian: KST_STANDARD_MERIDIAN,
      longitude: SEOUL_LONGITUDE,
      correctionMinutes: input.correctionMinutes,
      adjustedBirthDate: correctedDate,
      adjustedBirthTime: correctedClock,
      basis: '서울 지역시 기준'
    }
  };

  result.ui = buildUiModel(result, payload, {
    advice: `${pillars?.day || '일주'}를 중심으로 중요한 선택의 리듬을 맞추고, ${dayElement?.stem || '핵심'} 기운이 살아나는 일 방식과 인간관계를 정리해 보세요.`,
    intro: `${name}님의 사주를 서울 기준 지역시로 ${correctionText} 보정해 ${correctedDate} ${correctedClock} 기준으로 계산했습니다.`
  });

  return result;
}

function convertToManseryeokInput(payload) {
  const [birthYear, birthMonth, birthDay] = String(payload.birthDate || '').split('-').map(Number);
  const [birthHour, birthMinute] = String(payload.birthTime || '00:00').split(':').map(Number);

  let solarDate = { year: birthYear, month: birthMonth, day: birthDay };
  if (payload.calendar === 'lunar') {
    solarDate = lunarToSolar(birthYear, birthMonth, birthDay, Boolean(payload.isLeapMonth));
  }

  const adjusted = applySeoulLocalSolarTime({
    year: solarDate.year,
    month: solarDate.month,
    day: solarDate.day,
    hour: birthHour || 0,
    minute: birthMinute || 0
  });

  return {
    year: adjusted.year,
    month: adjusted.month,
    day: adjusted.day,
    hour: adjusted.hour,
    minute: adjusted.minute,
    correctionMinutes: adjusted.correctionMinutes
  };
}

function applySeoulLocalSolarTime(parts) {
  const utcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour || 0, parts.minute || 0, 0);
  const adjusted = new Date(utcMs + SEOUL_LOCAL_SOLAR_OFFSET_MINUTES * 60 * 1000);
  return {
    year: adjusted.getUTCFullYear(),
    month: adjusted.getUTCMonth() + 1,
    day: adjusted.getUTCDate(),
    hour: adjusted.getUTCHours(),
    minute: adjusted.getUTCMinutes(),
    correctionMinutes: SEOUL_LOCAL_SOLAR_OFFSET_MINUTES
  };
}

function formatClock(hour, minute) {
  return `${String(hour || 0).padStart(2, '0')}:${String(minute || 0).padStart(2, '0')}`;
}

function formatDateParts(year, month, day) {
  return `${String(year || '').padStart(4, '0')}-${String(month || '').padStart(2, '0')}-${String(day || '').padStart(2, '0')}`;
}

function buildManseryeokTags({ pillars, pillarsHanja, dayElement, dayYinYang, payload, input }) {
  const correctionLabel = Number.isFinite(input?.correctionMinutes) ? `서울 지역시 ${input.correctionMinutes > 0 ? '+' : ''}${input.correctionMinutes}분` : '';
  const pool = [
    dayElement?.stem ? `${dayElement.stem} 기운` : '',
    dayElement?.branch ? `${dayElement.branch} 보조` : '',
    dayYinYang?.stem ? `${dayYinYang.stem}의 리듬` : '',
    pillars?.day ? `일주 ${pillars.day}` : '',
    correctionLabel,
    payload.calendar === 'lunar' ? '음력 입력' : '양력 입력',
    pillarsHanja?.day?.hanja || ''
  ];
  return [...new Set(pool.filter(Boolean))].slice(0, 4);
}

function pillarToHanja(pillar) {
  const stemMap = { 갑: '甲', 을: '乙', 병: '丙', 정: '丁', 무: '戊', 기: '己', 경: '庚', 신: '辛', 임: '壬', 계: '癸' };
  const branchMap = { 자: '子', 축: '丑', 인: '寅', 묘: '卯', 진: '辰', 사: '巳', 오: '午', 미: '未', 신: '申', 유: '酉', 술: '戌', 해: '亥' };
  const text = String(pillar || '').trim();
  if (text.length < 2) return '-';
  return `${stemMap[text[0]] || ''}${branchMap[text[1]] || ''}` || '-';
}

function buildFallbackPillarDetails(pillars = {}) {
  const yinYangStemMap = { 갑: '양', 을: '음', 병: '양', 정: '음', 무: '양', 기: '음', 경: '양', 신: '음', 임: '양', 계: '음' };
  const yinYangBranchMap = { 자: '양', 축: '음', 인: '양', 묘: '음', 진: '양', 사: '음', 오: '양', 미: '음', 신: '양', 유: '음', 술: '양', 해: '음' };
  const ohaengStemMap = { 갑: '목', 을: '목', 병: '화', 정: '화', 무: '토', 기: '토', 경: '금', 신: '금', 임: '수', 계: '수' };
  const ohaengBranchMap = { 자: '수', 축: '토', 인: '목', 묘: '목', 진: '토', 사: '화', 오: '화', 미: '토', 신: '금', 유: '금', 술: '토', 해: '수' };
  const make = (pillar, label) => {
    const text = String(pillar || '');
    const gan = text[0] || '';
    const ji = text[1] || '';
    return {
      hangul: text,
      hanja: pillarToHanja(text),
      eumyang: { gan: yinYangStemMap[gan] || '-', ji: yinYangBranchMap[ji] || '-' },
      ohaeng: { gan: ohaengStemMap[gan] || '-', ji: ohaengBranchMap[ji] || '-' },
      sipseong: { gan: label === 'day' ? '일간' : '-', ji: '-' }
    };
  };
  return {
    year: make(pillars.year, 'year'),
    month: make(pillars.month, 'month'),
    day: make(pillars.day, 'day'),
    hour: make(pillars.hour, 'hour')
  };
}

function buildMockSummary(payload, meta = {}) {
  const stems = ['갑', '을', '병', '정', '무', '기', '경', '신', '임', '계'];
  const branches = ['자', '축', '인', '묘', '진', '사', '오', '미', '신', '유', '술', '해'];
  const elementTags = [
    ['목 기운', '새로운 시작에 강해요'],
    ['화 기운', '표현력과 추진력이 보여요'],
    ['토 기운', '안정감과 현실감이 느껴져요'],
    ['금 기운', '기준과 판단력이 분명해요'],
    ['수 기운', '감수성과 유연함이 좋아요']
  ];
  const [year, month, day] = payload.birthDate.split('-').map(Number);
  const hour = Number(payload.birthTime.split(':')[0] || 0);
  const base = year + month + day + hour;
  const makePillar = (seed) => stems[seed % stems.length] + branches[seed % branches.length];

  const result = {
    provider: meta.provider || 'mock',
    year: makePillar(base + 1),
    month: makePillar(base + 5),
    day: makePillar(base + 9),
    hour: makePillar(base + 13),
    tags: [
      elementTags[base % 5][0],
      elementTags[(base + 1) % 5][0],
      '차분한 집중형',
      '관계 균형 중시'
    ],
    summary: `${elementTags[base % 5][1]} 전체적으로는 부드럽고 섬세한 감각 안에 자신만의 기준이 있는 편으로 보여요. 중요한 순간에는 감정과 현실을 함께 살피며, 서두르기보다 리듬을 만들 때 더 좋은 성과가 납니다.`,
    trait: '처음에는 조심스럽지만 한 번 방향을 정하면 꾸준히 밀고 가는 힘이 있습니다. 주변 분위기를 잘 읽고, 나만의 속도를 지킬 때 안정감이 커집니다.',
    love: '관계에서는 편안함과 신뢰를 중요하게 여기는 편입니다. 감정 표현을 조금 더 자주 해주면 오해가 줄고, 상대와의 온도가 더 잘 맞아갑니다.',
    work: '일과 재물에서는 급하게 크게 벌리기보다, 잘하는 영역을 반복해서 쌓는 방식이 유리합니다. 장기전에서 강점이 살아나는 타입입니다.',
    pillarDetails: buildFallbackPillarDetails({
      year: makePillar(base + 1),
      month: makePillar(base + 5),
      day: makePillar(base + 9),
      hour: makePillar(base + 13)
    })
  };
  result.ui = buildUiModel(result, payload);
  return result;
}

function buildUiModel(result, payload, parsed = null) {
  const name = payload?.name || '사용자';
  const coreTag = (result.tags && result.tags[0]) || '균형 기운';
  const secondTag = (result.tags && result.tags[1]) || '안정 흐름';
  const sourceLabel = '';
  const advice =
    pickFirst(
      parsed?.advice,
      parsed?.analysis?.advice,
      parsed?.tips,
      parsed?.guidance,
      parsed?.interpretation?.advice
    ) || `${coreTag}을 살리려면 서두르기보다 리듬을 만드는 선택이 유리합니다.`;

  return {
    sourceLabel,
    intro: pickFirst(parsed?.intro, `${name}님의 사주를 모바일 카드에서 읽기 쉽게 정리한 요약입니다.`),
    summaryTitle: `${coreTag} 중심으로 보는 현재 흐름`,
    summaryBody: shortenText(result.summary, 140),
    traitTitle: `${coreTag}으로 읽는 타고난 기질`,
    traitBody: shortenText(result.trait, 92),
    loveTitle: '관계에서 드러나는 모습',
    loveBody: shortenText(result.love, 92),
    workTitle: `${secondTag}을 반영한 일·재물 흐름`,
    workBody: shortenText(result.work, 92),
    advice,
    premiumHint: '프리미엄 리포트에서는 대운·세운, 연애운, 직업운, 재물운을 더 길고 구체적인 문장으로 풀어줍니다.'
  };
}

function shortenText(text, limit = 100) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= limit) return clean;
  const clipped = clean.slice(0, limit);
  const lastBreak = Math.max(clipped.lastIndexOf('.'), clipped.lastIndexOf(' '), clipped.lastIndexOf('다'));
  const safe = lastBreak > limit * 0.55 ? clipped.slice(0, lastBreak + 1).trim() : clipped.trim();
  return safe.replace(/[\s,.;:]+$/,'') + '…';
}

async function requestPayAppPayment(order) {
  const params = new URLSearchParams({
    cmd: 'payrequest',
    userid: process.env.PAYAPP_USERID || '',
    shopname: process.env.PAYAPP_SHOPNAME || '다온사주',
    goodname: order.goodname,
    price: String(order.price),
    recvphone: order.recvphone,
    linkkey: process.env.PAYAPP_LINKKEY || '',
    linkval: process.env.PAYAPP_LINKVAL || '',
    var1: order.orderId,
    redirecturl: `${APP_BASE_URL}/payment/return?orderId=${encodeURIComponent(order.orderId)}`,
    returnurl: `${APP_BASE_URL}/payment/return?orderId=${encodeURIComponent(order.orderId)}`,
    feedbackurl: `${APP_BASE_URL}/api/pay/feedback`
  });

  const response = await fetch('https://api.payapp.kr/oapi/apiLoad.html', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params
  });

  const raw = await response.text();
  const data = Object.fromEntries(new URLSearchParams(raw));
  const ok = String(data.state || '') === '1' && !!data.payurl;

  return {
    ok,
    raw,
    data,
    message: data.errorMessage || data.message || `HTTP ${response.status}`
  };
}

function normalizeUserInput(input = {}) {
  const birthDate = input.birthDate || buildBirthDate(input.year, input.month, input.day);
  return {
    name: String(input.name || input.nickname || '사용자'),
    birthDate,
    birthTime: String(input.birthTime || input.time || '00:00').slice(0, 5),
    calendar: input.calendar || input.calendarType || 'solar',
    isLeapMonth: input.isLeapMonth === true || input.leapMonth === true || input.leapMonth === 'true',
    gender: input.gender || 'female'
  };
}

function buildBirthDate(year, month, day) {
  const y = String(year || '').padStart(4, '0');
  const m = String(month || '').padStart(2, '0');
  const d = String(day || '').padStart(2, '0');
  return y && m && d ? `${y}-${m}-${d}` : '';
}

function buildTagsFromParsed(parsed, fallbackTags) {
  const pool = [];
  const push = (value) => {
    if (!value) return;
    if (Array.isArray(value)) value.forEach(push);
    else if (typeof value === 'string') pool.push(value.trim());
    else if (typeof value === 'object') Object.values(value).forEach(push);
  };
  push(parsed?.elements);
  push(parsed?.keywords);
  push(parsed?.tags);
  push(parsed?.saju?.elements);
  const uniq = [...new Set(pool.filter(Boolean))].slice(0, 4);
  return uniq.length ? uniq : fallbackTags;
}

function pickFirst(...values) {
  for (const value of values) {
    if (!value) continue;
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) return value.map(String).join(' / ');
    if (typeof value === 'object') {
      const merged = Object.values(value).map(String).join(' / ').trim();
      if (merged) return merged;
    }
  }
  return '';
}

function pillarString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  const stem = value.stem || value.heavenlyStem || value.천간 || '';
  const branch = value.branch || value.earthlyBranch || value.지지 || '';
  return `${stem}${branch}`.trim();
}

function extractTextFromToolResult(toolResult) {
  if (!toolResult) return '';
  if (typeof toolResult === 'string') return toolResult;
  if (Array.isArray(toolResult.content)) {
    return toolResult.content
      .filter((item) => item.type === 'text' && item.text)
      .map((item) => item.text)
      .join('\n')
      .trim();
  }
  return JSON.stringify(toolResult, null, 2);
}

function tryParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function hasPayAppCredentials() {
  return missingPayAppEnvKeys().length === 0;
}

function missingPayAppEnvKeys() {
  return ['PAYAPP_USERID', 'PAYAPP_LINKKEY', 'PAYAPP_LINKVAL'].filter((key) => !process.env[key]);
}

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    await fs.access(ORDERS_FILE);
  } catch {
    await fs.writeFile(ORDERS_FILE, '[]\n', 'utf8');
  }
}

async function listOrders() {
  const text = await fs.readFile(ORDERS_FILE, 'utf8');
  return JSON.parse(text);
}

async function writeOrders(orders) {
  await fs.writeFile(ORDERS_FILE, `${JSON.stringify(orders, null, 2)}\n`, 'utf8');
}

async function getOrder(orderId) {
  const orders = await listOrders();
  return orders.find((item) => item.orderId === orderId) || null;
}

async function upsertOrder(order) {
  const orders = await listOrders();
  const index = orders.findIndex((item) => item.orderId === order.orderId);
  if (index >= 0) orders[index] = { ...orders[index], ...order };
  else orders.push(order);
  await writeOrders(orders);
}

async function patchOrder(orderId, patch) {
  const orders = await listOrders();
  const index = orders.findIndex((item) => item.orderId === orderId);
  if (index === -1) return null;
  orders[index] = { ...orders[index], ...patch };
  await writeOrders(orders);
  return orders[index];
}

async function serveStaticFile(res, pathname) {
  const safePath = pathname === '/' ? '/index.html' : pathname;
  const absolutePath = path.join(PUBLIC_DIR, safePath.replace(/^\/+/, ''));
  if (!absolutePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return sendJson(res, 404, { error: 'Not found' });
    const body = await fs.readFile(absolutePath);
    return sendBuffer(res, 200, body, guessContentType(absolutePath));
  } catch {
    return sendJson(res, 404, { error: 'Not found' });
  }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength
  });
  res.end(body);
}

function sendText(res, status, text) {
  const body = Buffer.from(String(text));
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': body.byteLength
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.byteLength
  });
  res.end(body);
}

function sendBuffer(res, status, body, contentType) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.byteLength
  });
  res.end(body);
}

async function readJsonBody(req) {
  const text = await readBody(req);
  return text ? JSON.parse(text) : {};
}

async function readFormBody(req) {
  const text = await readBody(req);
  return Object.fromEntries(new URLSearchParams(text));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function guessContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

function loadEnv(envPath) {
  try {
    const text = fsSync.readFileSync(envPath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key && !(key in process.env)) process.env[key] = value;
    }
  } catch {}
}

function renderPaymentReturnPage(order) {
  const safeStatus = order?.status || 'unknown';
  const reportLink = order ? `/report/view?orderId=${encodeURIComponent(order.orderId)}` : '/';
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>결제 상태 확인</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR",sans-serif;background:#fffaf6;margin:0;padding:24px;color:#3b2f2a}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #f1dfcf;border-radius:24px;padding:24px;box-shadow:0 18px 40px rgba(103,74,50,.10)}
h1{margin:0 0 12px;font-size:28px}p{line-height:1.7;color:#6d5f59}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:52px;padding:0 18px;border-radius:16px;background:#3f3835;color:#fff;text-decoration:none;font-weight:800;margin-top:16px}
</style>
</head>
<body>
  <div class="card">
    <h1>결제 상태 확인</h1>
    <p>현재 주문 상태는 <strong>${escapeHtml(safeStatus)}</strong> 입니다.</p>
    <p>PayApp의 최종 결제완료 처리는 서버의 feedbackurl 검증 이후 반영됩니다. 결제 직후 잠시 후 다시 확인해 주세요.</p>
    <a class="btn" href="${reportLink}">상세 리포트 열람 상태 확인</a>
  </div>
</body>
</html>`;
}

function renderReportGatePage(order) {
  const canOpen = order?.status === 'paid';
  const body = canOpen
    ? '<p>결제가 확인되었습니다. 이제 상세 리포트 생성/열람 로직을 연결하면 됩니다.</p>'
    : '<p>아직 결제 확인이 완료되지 않았습니다. feedbackurl 검증이 끝나면 이 페이지에서 리포트 열람을 허용하도록 확장하세요.</p>';
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>리포트 열람</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard","Noto Sans KR",sans-serif;background:#fffaf6;margin:0;padding:24px;color:#3b2f2a}
.card{max-width:460px;margin:0 auto;background:#fff;border:1px solid #f1dfcf;border-radius:24px;padding:24px;box-shadow:0 18px 40px rgba(103,74,50,.10)}
h1{margin:0 0 12px;font-size:28px}p{line-height:1.7;color:#6d5f59}
pre{white-space:pre-wrap;background:#fff8ee;border:1px solid #f1dfcf;border-radius:16px;padding:14px;font-size:13px;line-height:1.6;overflow:auto}
a{color:#3f3835}
</style>
</head>
<body>
  <div class="card">
    <h1>프리미엄 리포트 게이트</h1>
    ${body}
    <pre>${escapeHtml(JSON.stringify(order || { message: 'order not found' }, null, 2))}</pre>
    <p><a href="/">메인으로 돌아가기</a></p>
  </div>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
