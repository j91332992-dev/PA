(function () {
  'use strict';

  const slides = [
    { name: '오프닝 훅 / 아침 영상', short: 'HOOK', time: '0:35', file: 'slides/story/01-hook.html?v=20260819-06' },
    { name: '핵심 질문', short: 'QUESTION', time: '0:35', file: 'slides/story/02-question.html' },
    { name: '제목·팀 소개', short: 'INTRO', time: '0:25', file: 'slides/story/03-intro-clean.html' },
    { name: '문제 정의', short: 'PROBLEM MAP', time: '0:20', file: 'slides/story/04-problem-definition.html' },
    { name: '문제 01 / 위치', short: 'LOCATION', time: '0:30', file: 'slides/story/05-location-problem.html?v=20260819-05' },
    { name: '사용자 조사', short: 'EVIDENCE', time: '0:35', file: 'slides/story/06-evidence.html' },
    { name: '문제 02 / 기억', short: 'MEMORY', time: '0:30', file: 'slides/story/07-memory-problem.html' },
    { name: '시장 분석', short: 'MARKET', time: '0:40', file: 'slides/story/08-market.html' },
    { name: '고객 분석', short: 'CUSTOMER', time: '0:45', file: 'slides/story/09-customer.html' },
    { name: '해결책 제안', short: 'SOLUTION', time: '0:45', file: 'slides/story/10-solution.html' },
    { name: '시스템 동작 원리', short: 'SYSTEM FLOW', time: '1:00', file: 'slides/story/11-system.html' },
    { name: '앱 사용 방법', short: 'APP FLOW', time: '0:35', file: 'slides/story/12-app.html' },
    { name: '라이브 시연', short: 'LIVE DEMO', time: '1:35', file: 'slides/story/13-live.html' },
    { name: '서비스·검증', short: 'VALIDATION', time: '0:50', file: 'slides/story/14-validation.html' },
    { name: '마무리', short: 'TAKEAWAY', time: '1:00', file: 'slides/story/15-close.html' }
  ];
  window.PRESENTATION_SLIDES = slides;

  const query = new URLSearchParams(window.location.search);
  window.PRESENTATION_EMBEDS = {
    desktop: query.get('desktop') || '',
    mobile: query.get('mobile') || ''
  };

  const frame = document.getElementById('slideFrame');
  const loading = document.getElementById('loading');
  const progress = document.getElementById('progress');
  const indicator = document.getElementById('indicator');
  const prevButton = document.getElementById('prevBtn');
  const nextButton = document.getElementById('nextBtn');
  const autoButton = document.getElementById('autoBtn');
  const fullscreenButton = document.getElementById('fullscreenBtn');
  const outlineButton = document.getElementById('outlineBtn');
  const outlinePanel = document.getElementById('outlinePanel');
  const outlineClose = document.getElementById('outlineClose');
  const outlineList = document.getElementById('outlineList');

  let current = 0;
  let autoTimer = null;

  function renderOutline() {
    outlineList.innerHTML = slides.map(function (slide, index) {
      return '<button class="outline-item" type="button" data-index="' + index + '"><span class="outline-num">' + String(index + 1).padStart(2, '0') + '</span><span class="outline-name">' + slide.name + '</span><span class="outline-time">' + slide.time + '</span></button>';
    }).join('');
    outlineList.querySelectorAll('.outline-item').forEach(function (item) {
      item.addEventListener('click', function () {
        render(Number(item.dataset.index), true);
        setOutline(false);
      });
    });
  }

  function setOutline(open) {
    outlinePanel.classList.toggle('is-open', open);
    outlinePanel.setAttribute('aria-hidden', open ? 'false' : 'true');
    outlineButton.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function syncOutline() {
    outlineList.querySelectorAll('.outline-item').forEach(function (item, index) {
      item.classList.toggle('is-current', index === current);
    });
  }

  function indexFromHash() {
    const match = window.location.hash.match(/slide-(\d+)/i);
    const value = match ? Number(match[1]) - 1 : 0;
    return Math.max(0, Math.min(slides.length - 1, Number.isFinite(value) ? value : 0));
  }

  function syncUrl() {
    window.history.replaceState(null, '', '#slide-' + (current + 1));
  }

  function render(index, updateHash) {
    current = Math.max(0, Math.min(slides.length - 1, index));
    if (updateHash) syncUrl();

    loading.classList.remove('is-hidden');
    frame.src = slides[current].file;
    indicator.textContent = String(current + 1).padStart(2, '0') + ' / ' + String(slides.length).padStart(2, '0');
    progress.style.width = ((current + 1) / slides.length * 100) + '%';
    prevButton.disabled = current === 0;
    nextButton.disabled = current === slides.length - 1;
    syncOutline();
  }

  function next() {
    if (current < slides.length - 1) render(current + 1, true);
  }

  function previous() {
    if (current > 0) render(current - 1, true);
  }

  function setAuto(enabled) {
    window.clearInterval(autoTimer);
    autoTimer = null;
    autoButton.classList.toggle('off', !enabled);
    autoButton.textContent = enabled ? '자동 진행 ON' : '자동 진행 OFF';
    if (enabled) {
      autoTimer = window.setInterval(function () {
        if (current === slides.length - 1) setAuto(false);
        else next();
      }, 16000);
    }
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  }

  frame.addEventListener('load', function () {
    loading.classList.add('is-hidden');
  });
  prevButton.addEventListener('click', previous);
  nextButton.addEventListener('click', next);
  autoButton.addEventListener('click', function () {
    setAuto(!autoTimer);
  });
  fullscreenButton.addEventListener('click', toggleFullscreen);
  outlineButton.addEventListener('click', function () { setOutline(!outlinePanel.classList.contains('is-open')); });
  outlineClose.addEventListener('click', function () { setOutline(false); });
  window.addEventListener('hashchange', function () {
    const nextIndex = indexFromHash();
    if (nextIndex !== current) render(nextIndex, false);
  });

  document.addEventListener('keydown', function (event) {
    const target = event.target;
    if (target && /input|textarea|select/i.test(target.tagName)) return;
    if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
      event.preventDefault();
      next();
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      previous();
    } else if (event.key === 'Home') {
      event.preventDefault();
      render(0, true);
    } else if (event.key === 'End') {
      event.preventDefault();
      render(slides.length - 1, true);
    } else if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      toggleFullscreen();
    } else if (event.key.toLowerCase() === 'o') {
      event.preventDefault();
      setOutline(!outlinePanel.classList.contains('is-open'));
    } else if (event.key === 'Escape') {
      setOutline(false);
    }
  });

  renderOutline();
  render(indexFromHash(), false);
}());
