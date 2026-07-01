(() => {
  const reviewTrack = document.getElementById('reviewSliderTrack');
  const reviewPrev = document.getElementById('reviewPrev');
  const reviewNext = document.getElementById('reviewNext');
  const reviewDots = document.getElementById('reviewDots');
  const reviewSlides = Array.from(document.querySelectorAll('.review-slide'));
  const faqItems = Array.from(document.querySelectorAll('.faq-item'));
  let reviewIndex = 0;
  let reviewTimer = null;

  function initFaq() {
    faqItems.forEach((item) => {
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
    Array.from(reviewDots?.children || []).forEach((dot, idx) => {
      dot.classList.toggle('active', idx === reviewIndex);
    });
  }

  function startSliderTimer() {
    if (reviewTimer) clearInterval(reviewTimer);
    reviewTimer = setInterval(() => goToReview(reviewIndex + 1), 4000);
  }

  function restartSliderTimer() {
    startSliderTimer();
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
    reviewTrack.addEventListener('touchstart', () => reviewTimer && clearInterval(reviewTimer), { passive: true });
    reviewTrack.addEventListener('touchend', startSliderTimer, { passive: true });
    startSliderTimer();
  }

  document.addEventListener('DOMContentLoaded', () => {
    initReviewSlider();
    initFaq();
  });
})();
