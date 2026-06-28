(() => {
  const modal = document.getElementById('premiumModal');
  const closeButton = document.getElementById('premiumModalClose');
  const bottomApplyButton = document.getElementById('bottomApplyButton');
  const payButton = document.getElementById('payButton');
  const resultPremiumButton = document.getElementById('resultPremiumButton');
  const premiumForm = document.getElementById('premiumRequestForm');
  const statusInline = document.getElementById('premiumStatusInline');
  const compatibilityToggle = document.getElementById('compatibilityToggle');
  const compatibilityFields = document.getElementById('compatibilityFields');
  const orderProductName = document.getElementById('orderProductName');
  const orderProductPrice = document.getElementById('orderProductPrice');

  const reviewTrack = document.getElementById('reviewSliderTrack');
  const reviewPrev = document.getElementById('reviewPrev');
  const reviewNext = document.getElementById('reviewNext');
  const reviewDots = document.getElementById('reviewDots');
  const reviewSlides = Array.from(document.querySelectorAll('.review-slide'));
  let reviewIndex = 0;
  let reviewTimer = null;

  function showStatus(message, isError = false) {
    if (!statusInline) return;
    statusInline.textContent = message;
    statusInline.classList.add('show');
    statusInline.style.background = isError ? '#fff0ef' : '#f8f3ee';
    statusInline.style.color = isError ? '#9a4b43' : '#6f625b';
  }

  function clearStatus() {
    if (!statusInline) return;
    statusInline.textContent = '';
    statusInline.classList.remove('show');
  }

  function getFreeSummarySeed() {
    const state = typeof window.__getLatestSummaryState === 'function'
      ? window.__getLatestSummaryState()
      : { seed: window.__freeSummarySeed || null };
    return state?.seed || window.__freeSummarySeed || null;
  }

  function openPremiumModal(options = {}) {
    syncPremiumFormFromSummary({ force: options.force === true });
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    clearStatus();
  }

  function closePremiumModal() {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  function syncPremiumFormFromSummary(options = {}) {
    const seed = getFreeSummarySeed();
    const force = options.force === true;
    const setTargetValue = (targetId, nextValue) => {
      const target = document.getElementById(targetId);
      if (!target) return;
      if (force || !target.value) target.value = nextValue || '';
    };
    const seedValue = (key, fallback = '') => seed && seed[key] != null ? seed[key] : fallback;

    setTargetValue('premiumName', seedValue('name', document.getElementById('name')?.value || ''));
    setTargetValue('premiumYear', seedValue('birthYear', seedValue('year', document.getElementById('year')?.value || '')));
    setTargetValue('premiumMonth', seedValue('birthMonth', seedValue('month', document.getElementById('month')?.value || '')));
    setTargetValue('premiumDay', seedValue('birthDay', seedValue('day', document.getElementById('day')?.value || '')));
    setTargetValue('premiumCalendarType', seedValue('calendarType', document.getElementById('calendarType')?.value || 'solar'));
    setTargetValue('premiumLeapMonth', String(seedValue('isLeapMonth', document.getElementById('leapMonth')?.value === 'true' ? 'true' : document.getElementById('leapMonth')?.value || 'false')));

    const premiumTime = document.getElementById('premiumTime');
    const seedTime = seedValue('birthTime', '');
    const timeHour = document.getElementById('timeHour')?.value || '';
    const timeMinute = document.getElementById('timeMinute')?.value || '';
    const fallbackTime = timeHour ? `${String(timeHour).padStart(2, '0')}:${String(timeMinute || '00').padStart(2, '0')}` : '';
    if (premiumTime && (force || !premiumTime.value)) {
      premiumTime.value = seedTime || fallbackTime;
    }

    const selectedGender = seedValue('gender', document.querySelector('input[name="gender"]:checked')?.value || '');
    if (selectedGender && (force || !document.querySelector('input[name="premiumGender"]:checked'))) {
      const targetGender = document.querySelector(`input[name="premiumGender"][value="${selectedGender}"]`);
      if (targetGender) targetGender.checked = true;
    }
    updateOrderSummary();
  }

  function isPartnerDataPresent() {
    return [
      'partnerName','partnerYear','partnerMonth','partnerDay','partnerTime','partnerMemo'
    ].some((id) => (document.getElementById(id)?.value || '').trim()) || Boolean(document.querySelector('input[name="partnerGender"]:checked'));
  }

  function setCompatibility(enabled) {
    compatibilityToggle.classList.toggle('active', enabled);
    compatibilityToggle.setAttribute('aria-pressed', String(enabled));
    compatibilityFields.classList.toggle('open', enabled);
    updateOrderSummary();
  }

  function currentProduct() {
    const compatibility = compatibilityToggle.classList.contains('active') || isPartnerDataPresent();
    return compatibility
      ? { type: 'compatibility', label: '2인 사주(궁합 무료 진행)', price: 36000 }
      : { type: 'single', label: '프리미엄 사주 리포트', price: 18900 };
  }

  function updateOrderSummary() {
    const product = currentProduct();
    orderProductName.textContent = product.label;
    orderProductPrice.textContent = `${product.price.toLocaleString('ko-KR')}원`;
  }

  function cleanDigits(value) {
    return String(value || '').replace(/[^0-9]/g, '');
  }

  function normalizeTime(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^\d{1,2}:\d{2}$/.test(raw)) return raw.padStart(5, '0');
    const digits = cleanDigits(raw);
    if (digits.length === 3) return `${digits[0]}${digits[1]}:${digits[2]}0`;
    if (digits.length === 4) return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
    return raw;
  }

  function buildPayload() {
    const product = currentProduct();
    const applicant = {
      name: document.getElementById('premiumName').value.trim(),
      gender: document.querySelector('input[name="premiumGender"]:checked')?.value || '',
      birthYear: cleanDigits(document.getElementById('premiumYear').value),
      birthMonth: cleanDigits(document.getElementById('premiumMonth').value),
      birthDay: cleanDigits(document.getElementById('premiumDay').value),
      birthTime: normalizeTime(document.getElementById('premiumTime').value),
      calendarType: document.getElementById('premiumCalendarType').value,
      isLeapMonth: document.getElementById('premiumLeapMonth').value,
      concern: document.getElementById('premiumConcern').value.trim()
    };
    const payload = {
      productType: product.type,
      applicant,
      person1: { ...applicant },
      partner: null,
      person2: null,
      compatibilityRequested: product.type === 'compatibility'
    };

    if (payload.compatibilityRequested || isPartnerDataPresent()) {
      payload.partner = {
        name: document.getElementById('partnerName').value.trim(),
        gender: document.querySelector('input[name="partnerGender"]:checked')?.value || '',
        birthYear: cleanDigits(document.getElementById('partnerYear').value),
        birthMonth: cleanDigits(document.getElementById('partnerMonth').value),
        birthDay: cleanDigits(document.getElementById('partnerDay').value),
        birthTime: normalizeTime(document.getElementById('partnerTime').value),
        calendarType: document.getElementById('partnerCalendarType').value,
        memo: document.getElementById('partnerMemo').value.trim()
      };
      payload.person2 = { ...payload.partner };
    }

    return payload;
  }

  function validatePayload(payload) {
    const a = payload.applicant;
    if (!a.name || !a.gender || !a.birthYear || !a.birthMonth || !a.birthDay) {
      throw new Error('이름, 성별, 생년월일은 필수입니다.');
    }
    if (payload.compatibilityRequested) {
      const p = payload.partner || {};
      const enoughPartner = p.name && p.gender && p.birthYear && p.birthMonth && p.birthDay;
      if (!enoughPartner) {
        throw new Error('2인 사주는 상대방 이름, 성별, 생년월일을 입력해 주세요.');
      }
    }
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || '요청 처리 중 오류가 발생했습니다.');
    }
    return data;
  }

  async function submitPremiumRequest(event) {
    event.preventDefault();
    const submitButton = premiumForm.querySelector('button[type="submit"]');
    const originalText = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.textContent = '결제창 준비 중...';
    try {
      const payload = buildPayload();
      validatePayload(payload);
      showStatus('결제 정보를 준비하고 있습니다. 잠시만 기다려주세요.');
      const data = await requestJson('/api/orders/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      showStatus('결제창으로 이동합니다. 결제 완료 후 리포트 생성 상태 화면으로 안내됩니다.');
      window.location.href = data.paymentUrl;
    } catch (error) {
      console.error(error);
      showStatus(error.message || '결제 요청 중 오류가 발생했습니다.', true);
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = originalText;
    }
  }

  function initFaq() {
    document.querySelectorAll('.faq-item').forEach((item) => {
      const button = item.querySelector('.faq-question');
      button?.addEventListener('click', () => {
        const open = item.classList.toggle('open');
        button.setAttribute('aria-expanded', String(open));
      });
    });
  }

  function goToReview(index) {
    if (!reviewTrack || !reviewSlides.length) return;
    reviewIndex = (index + reviewSlides.length) % reviewSlides.length;
    const slide = reviewSlides[reviewIndex];
    const offset = slide.offsetLeft - 4;
    reviewTrack.style.transform = `translateX(${-offset}px)`;
    Array.from(reviewDots.children).forEach((dot, idx) => {
      dot.classList.toggle('active', idx === reviewIndex);
    });
  }

  function buildReviewDots() {
    if (!reviewDots) return;
    reviewDots.innerHTML = '';
    reviewSlides.forEach((_, idx) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'review-dot' + (idx === 0 ? ' active' : '');
      button.setAttribute('aria-label', `${idx + 1}번 후기 보기`);
      button.addEventListener('click', () => {
        goToReview(idx);
        restartSliderTimer();
      });
      reviewDots.appendChild(button);
    });
  }

  function startSliderTimer() {
    if (reviewTimer) clearInterval(reviewTimer);
    reviewTimer = setInterval(() => goToReview(reviewIndex + 1), 4000);
  }

  function restartSliderTimer() {
    startSliderTimer();
  }

  function initReviewSlider() {
    if (!reviewTrack || !reviewSlides.length) return;
    buildReviewDots();
    goToReview(0);
    reviewPrev?.addEventListener('click', () => {
      goToReview(reviewIndex - 1);
      restartSliderTimer();
    });
    reviewNext?.addEventListener('click', () => {
      goToReview(reviewIndex + 1);
      restartSliderTimer();
    });
    window.addEventListener('resize', () => goToReview(reviewIndex));
    reviewTrack.addEventListener('mouseenter', () => reviewTimer && clearInterval(reviewTimer));
    reviewTrack.addEventListener('mouseleave', startSliderTimer);
    startSliderTimer();
  }

  function launchPremiumFlow(options = {}) {
    const source = options.source || 'unknown';
    const force = options.force !== false;
    const state = typeof window.__getLatestSummaryState === 'function' ? window.__getLatestSummaryState() : { summary: null, seed: getFreeSummarySeed() };
    console.log('[PREMIUM CTA] launch', JSON.stringify({
      source,
      hasSummary: Boolean(state?.summary),
      hasSeed: Boolean(state?.seed)
    }));
    openPremiumModal({ force });
  }

  if (bottomApplyButton) {
    bottomApplyButton.type = 'button';
    bottomApplyButton.disabled = false;
    bottomApplyButton.addEventListener('click', () => launchPremiumFlow({ source: 'bottom_cta', force: true }));
  }
  if (payButton) {
    payButton.type = 'button';
    payButton.disabled = false;
    payButton.addEventListener('click', () => launchPremiumFlow({ source: 'main_cta', force: true }));
  }
  if (resultPremiumButton) {
    resultPremiumButton.type = 'button';
    resultPremiumButton.disabled = false;
    resultPremiumButton.style.pointerEvents = 'auto';
    resultPremiumButton.addEventListener('click', () => launchPremiumFlow({ source: 'result_cta', force: true }));
  }
  closeButton?.addEventListener('click', closePremiumModal);
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closePremiumModal();
  });
  premiumForm?.addEventListener('submit', submitPremiumRequest);
  compatibilityToggle?.addEventListener('click', () => setCompatibility(!compatibilityToggle.classList.contains('active')));

  ['partnerName','partnerYear','partnerMonth','partnerDay','partnerTime','partnerMemo'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', updateOrderSummary);
  });
  document.querySelectorAll('input[name="partnerGender"]').forEach((input) => input.addEventListener('change', updateOrderSummary));
  document.querySelectorAll('input[name="premiumGender"]').forEach((input) => input.addEventListener('change', updateOrderSummary));

  window.openPremiumModal = openPremiumModal;
  window.launchPremiumFlow = launchPremiumFlow;

  document.addEventListener('DOMContentLoaded', () => {
    initReviewSlider();
    initFaq();
    updateOrderSummary();
  });
})();
