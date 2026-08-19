(function () {
  'use strict';

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function mountVideoSlots() {
    document.querySelectorAll('[data-video-src]').forEach(function (slot) {
      var src = slot.getAttribute('data-video-src');
      var video = slot.querySelector('video');
      if (!src || !video) return;
      var shouldAutoplay = slot.getAttribute('data-video-autoplay') !== 'false';
      var shouldMute = slot.getAttribute('data-video-muted') !== 'false';
      video.src = src;
      video.controls = true;
      video.muted = shouldMute;
      video.autoplay = shouldAutoplay;
      video.playsInline = true;
      slot.classList.add('has-video');
      var playButton = slot.querySelector('[data-video-play]');
      function hidePlayButton() { playButton?.classList.add('is-hidden'); }
      function showPlayButton() { playButton?.classList.remove('is-hidden'); }
      if (playButton) {
        playButton.addEventListener('click', function () {
          video.muted = false;
          var playAttempt = video.play?.();
          if (playAttempt && typeof playAttempt.then === 'function') playAttempt.then(hidePlayButton).catch(function () {});
          else hidePlayButton();
        });
        video.addEventListener('play', hidePlayButton);
        video.addEventListener('ended', showPlayButton);
      }
      if (shouldAutoplay) video.play?.().catch(function () {});
    });
  }

  function fallbackReveal() {
    document.querySelectorAll('.animate-in, .animate-scale').forEach(function (element) {
      element.style.opacity = '1';
      element.style.transform = 'none';
    });
    document.querySelectorAll('.bar i').forEach(function (element) {
      element.style.transform = 'scaleX(1)';
    });
    document.querySelectorAll('.survey-ring-value').forEach(function (element) {
      element.style.strokeDasharray = '90 100';
    });
    document.querySelectorAll('.draw-line').forEach(function (element) {
      element.style.strokeDashoffset = '0';
    });
  }

  function animeReveal() {
    var items = Array.from(document.querySelectorAll('.animate-in'));
    var scales = Array.from(document.querySelectorAll('.animate-scale'));
    var timeline = anime.timeline({ autoplay: true, easing: 'easeOutCubic' });
    var itemEnd = Math.max(380, items.length * 72);

    timeline.add({
      targets: items,
      opacity: [0, 1],
      translateY: [22, 0],
      duration: 620,
      delay: anime.stagger(72),
      easing: 'easeOutCubic'
    }, 0);
    timeline.add({
      targets: scales,
      opacity: [0, 1],
      scale: [.92, 1],
      duration: 820,
      delay: anime.stagger(105),
      easing: 'easeOutElastic(1, .72)'
    }, Math.max(100, itemEnd - 210));
    timeline.add({
      targets: '.draw-line',
      strokeDashoffset: [900, 0],
      duration: 1050,
      easing: 'easeOutQuad'
    }, Math.max(320, itemEnd - 40));

    animateSlideDetails(itemEnd + 120);
  }

  function animateSlideDetails(startAt) {
    var bars = Array.from(document.querySelectorAll('.bar i'));
    bars.forEach(function (bar) { bar.style.transformOrigin = 'left center'; });
    if (bars.length) {
      anime({
        targets: bars,
        scaleX: [0, 1],
        duration: 1050,
        delay: anime.stagger(155, { start: startAt }),
        easing: 'easeOutCubic'
      });
    }

    var surveyRing = document.querySelector('.survey-ring-value');
    if (surveyRing) {
      anime({
        targets: surveyRing,
        strokeDasharray: ['0 100', '90 100'],
        duration: 1050,
        delay: startAt,
        easing: 'easeOutCubic'
      });
    }

    var trendDots = Array.from(document.querySelectorAll('.trend-dot'));
    if (trendDots.length) {
      anime({
        targets: trendDots,
        opacity: [0, 1],
        scale: [0, 1],
        duration: 520,
        delay: anime.stagger(150, { start: startAt + 180 }),
        easing: 'easeOutBack'
      });
    }

    var solutionSymbols = Array.from(document.querySelectorAll('.node-symbol'));
    if (solutionSymbols.length) {
      anime({
        targets: solutionSymbols,
        scale: [.78, 1],
        rotate: ['-8deg', '0deg'],
        duration: 700,
        delay: anime.stagger(180, { start: startAt + 120 }),
        easing: 'easeOutBack'
      });
    }

    var systemNodes = Array.from(document.querySelectorAll('.system-node'));
    if (systemNodes.length) {
      anime({
        targets: systemNodes,
        scale: [1, 1.045, 1],
        duration: 760,
        delay: anime.stagger(230, { start: startAt + 160 }),
        easing: 'easeInOutSine'
      });
    }

    var customerCards = Array.from(document.querySelectorAll('.customer-card'));
    if (customerCards.length) {
      anime({
        targets: customerCards,
        translateY: [8, 0],
        duration: 620,
        delay: anime.stagger(160, { start: startAt + 120 }),
        easing: 'easeOutCubic'
      });
    }

    var garments = Array.from(document.querySelectorAll('.garment'));
    if (garments.length) {
      anime({
        targets: garments,
        translateX: [16, 0],
        duration: 560,
        delay: anime.stagger(120, { start: startAt + 100 }),
        easing: 'easeOutCubic'
      });
      anime({
        targets: '.find-button',
        scale: [.88, 1],
        duration: 520,
        delay: anime.stagger(160, { start: startAt + 420 }),
        easing: 'easeOutBack'
      });
    }
  }

  function reveal() {
    if (reducedMotion()) return fallbackReveal();
    var items = document.querySelectorAll('.animate-in');
    var scales = document.querySelectorAll('.animate-scale');
    if (window.anime) {
      animeReveal();
      return;
    }
    if (window.gsap) {
      gsap.to(items, { opacity: 1, y: 0, duration: .7, stagger: .08, ease: 'power3.out' });
      gsap.to(scales, { opacity: 1, scale: 1, duration: .85, stagger: .1, ease: 'back.out(1.4)', delay: .12 });
      gsap.to('.draw-line', { strokeDashoffset: 0, duration: 1.1, ease: 'power2.out', delay: .35 });
      return;
    }
    fallbackReveal();
  }

  function ambientMotion() {
    if (reducedMotion()) return;
    if (window.anime) {
      anime({ targets: '.pulse-dot', scale: [1, 1.55, 1], opacity: [.7, 1, .7], duration: 1400, loop: true, easing: 'easeInOutSine' });
      anime({ targets: '.video-scan', translateY: ['0%', 'calc(100% - 2px)'], duration: 3600, loop: true, easing: 'linear' });
      anime({ targets: '.signal-ring', scale: [1, 1.22], opacity: [.55, 0], duration: 1700, loop: true, easing: 'easeOutQuad' });
    }
  }

  window.PresentationSlide = { reveal: reveal, mountVideoSlots: mountVideoSlots };
  document.addEventListener('DOMContentLoaded', function () {
    mountVideoSlots();
    reveal();
    ambientMotion();
    window.parent?.postMessage({ type: 'deck:ready', title: document.title }, '*');
  });
}());
