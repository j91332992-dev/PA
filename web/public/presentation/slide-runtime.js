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
      video.src = src;
      video.controls = true;
      video.muted = true;
      slot.classList.add('has-video');
    });
  }

  function fallbackReveal() {
    document.querySelectorAll('.animate-in, .animate-scale').forEach(function (element) {
      element.style.opacity = '1';
      element.style.transform = 'none';
    });
    document.querySelectorAll('.draw-line').forEach(function (element) {
      element.style.strokeDashoffset = '0';
    });
  }

  function reveal() {
    if (reducedMotion()) return fallbackReveal();
    var items = document.querySelectorAll('.animate-in');
    var scales = document.querySelectorAll('.animate-scale');
    if (window.gsap) {
      gsap.to(items, { opacity: 1, y: 0, duration: .7, stagger: .08, ease: 'power3.out' });
      gsap.to(scales, { opacity: 1, scale: 1, duration: .85, stagger: .1, ease: 'back.out(1.4)', delay: .12 });
      gsap.to('.draw-line', { strokeDashoffset: 0, duration: 1.1, ease: 'power2.out', delay: .35 });
      return;
    }
    if (window.anime) {
      anime({ targets: items, opacity: [0, 1], translateY: [20, 0], duration: 720, delay: anime.stagger(75), easing: 'easeOutCubic' });
      anime({ targets: scales, opacity: [0, 1], scale: [.94, 1], duration: 850, delay: anime.stagger(100, { start: 120 }), easing: 'easeOutBack' });
      anime({ targets: '.draw-line', strokeDashoffset: [900, 0], duration: 1100, delay: 350, easing: 'easeOutQuad' });
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
