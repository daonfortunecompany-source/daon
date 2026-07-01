(() => {
  const reviewTrack = document.getElementById('reviewTrack');
  const reviewPrev = document.getElementById('reviewPrev');
  const reviewNext = document.getElementById('reviewNext');
  const reviewDots = document.getElementById('reviewDots');
  const reviewSlides = Array.from(document.querySelectorAll('.review-slide'));
  const faqItems = Array.from(document.querySelectorAll('.faq-item'));
  const bookShots = Array.from(document.querySelectorAll('.book-shot'));

  const viewer = document.getElementById('bookViewer');
  const viewerImage = document.getElementById('bookViewerImage');
  const viewerCaption = document.getElementById('bookViewerCaption');
  const viewerCount = document.getElementById('bookViewerCount');
  const viewerClose = document.getElementById('bookViewerClose');
  const viewerPrev = document.getElementById('bookViewerPrev');
  const viewerNext = document.getElementById('bookViewerNext');

  let reviewIndex = 0;
  let sliderTimer = null;
  let viewerIndex = 0;

  const viewerItems = bookShots.map((button) => ({
    src: button.dataset.bookImage || '',
    caption: button.dataset.bookCaption || ''
  }));

  function goToReview(index) {
    if (!reviewTrack || !reviewSlides.length) return;
    reviewIndex = (index + reviewSlides.length) % reviewSlides.length;
    reviewTrack.style.transform = `translateX(-${reviewIndex * 100}%)`;
    Array.from(reviewDots?.children || []).forEach((dot, dotIndex) => {
      dot.classList.toggle('active', dotIndex === reviewIndex);
    });
  }

  function buildReviewDots() {
    if (!reviewDots || !reviewSlides.length) return;
    reviewDots.innerHTML = '';
    reviewSlides.forEach((_, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `review-dot${index === 0 ? ' active' : ''}`;
      button.setAttribute('aria-label', `${index + 1}번 후기 보기`);
      button.addEventListener('click', () => {
        goToReview(index);
        restartTimer();
      });
      reviewDots.appendChild(button);
    });
  }

  function startTimer() {
    if (!reviewSlides.length) return;
    if (sliderTimer) clearInterval(sliderTimer);
    sliderTimer = window.setInterval(() => {
      goToReview(reviewIndex + 1);
    }, 4500);
  }

  function restartTimer() {
    if (sliderTimer) clearInterval(sliderTimer);
    startTimer();
  }

  function bindReviewControls() {
    if (!reviewSlides.length) return;
    buildReviewDots();
    goToReview(0);
    reviewPrev?.addEventListener('click', () => {
      goToReview(reviewIndex - 1);
      restartTimer();
    });
    reviewNext?.addEventListener('click', () => {
      goToReview(reviewIndex + 1);
      restartTimer();
    });
    reviewTrack?.addEventListener('mouseenter', () => sliderTimer && clearInterval(sliderTimer));
    reviewTrack?.addEventListener('mouseleave', startTimer);
    reviewTrack?.addEventListener('touchstart', () => sliderTimer && clearInterval(sliderTimer), { passive: true });
    reviewTrack?.addEventListener('touchend', startTimer, { passive: true });
    startTimer();
  }

  function bindFaq() {
    faqItems.forEach((item) => {
      const button = item.querySelector('.faq-question');
      button?.addEventListener('click', () => {
        const isOpen = item.classList.toggle('open');
        button.setAttribute('aria-expanded', String(isOpen));
      });
    });
  }

  function updateViewer() {
    if (!viewerItems.length || !viewerImage || !viewerCaption || !viewerCount) return;
    const current = viewerItems[viewerIndex];
    viewerImage.src = current.src;
    viewerCaption.textContent = current.caption;
    viewerCount.textContent = `${viewerIndex + 1} / ${viewerItems.length}`;
  }

  function openViewer(index) {
    if (!viewer || !viewerItems.length) return;
    viewerIndex = (index + viewerItems.length) % viewerItems.length;
    updateViewer();
    viewer.classList.add('open');
    viewer.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeViewer() {
    if (!viewer) return;
    viewer.classList.remove('open');
    viewer.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
  }

  function stepViewer(delta) {
    if (!viewerItems.length) return;
    viewerIndex = (viewerIndex + delta + viewerItems.length) % viewerItems.length;
    updateViewer();
  }

  function bindViewer() {
    if (!viewer || !bookShots.length) return;
    bookShots.forEach((button, index) => {
      button.addEventListener('click', () => openViewer(index));
    });
    viewerClose?.addEventListener('click', closeViewer);
    viewerPrev?.addEventListener('click', () => stepViewer(-1));
    viewerNext?.addEventListener('click', () => stepViewer(1));
    viewer.addEventListener('click', (event) => {
      if (event.target === viewer) closeViewer();
    });
    document.addEventListener('keydown', (event) => {
      if (!viewer.classList.contains('open')) return;
      if (event.key === 'Escape') closeViewer();
      if (event.key === 'ArrowLeft') stepViewer(-1);
      if (event.key === 'ArrowRight') stepViewer(1);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindReviewControls();
    bindFaq();
    bindViewer();
  });
})();