(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HangerFreshness = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function hangerIdOf(hanger) { return String(hanger?.hangerId || '').toUpperCase(); }
  function bootIdOf(hanger) { return String(hanger?.bootId || 'legacy'); }
  function sequenceOf(hanger) {
    const value = Number(hanger?.lastSequence ?? hanger?.sequence ?? -1);
    return Number.isSafeInteger(value) && value >= 0 ? value : -1;
  }
  function updatedAtOf(hanger) {
    const value = Date.parse(hanger?.updatedAt || hanger?.lastSeen || '');
    return Number.isFinite(value) ? value : 0;
  }

  function clothingStatus(hanger, garments) {
    if ((hanger?.reportedState === 'PRESENT' || hanger?.state === 'PRESENT' || hanger?.state === 'UNKNOWN_TAG') && hanger.tagUid) {
      const name = (garments || []).find(garment => garment.tagUid === hanger.tagUid)?.name || '';
      return name ? `옷 감지됨 · ${name}` : `새 옷 감지됨 · 미등록 태그 (${hanger.tagUid})`;
    }
    return '걸린 옷 없음';
  }

  function createTracker() {
    const states = new Map();
    function isFresher(incoming, current) {
      const id = hangerIdOf(incoming);
      if (!id) return true;
      const incomingBoot = bootIdOf(incoming);
      const known = states.get(id);
      const currentBoot = current ? bootIdOf(current) : known?.bootId;
      const currentSequence = Math.max(sequenceOf(current), known?.bootId === currentBoot ? known.sequence : -1);
      if (currentBoot === incomingBoot) {
        const incomingSequence = sequenceOf(incoming);
        if (incomingSequence >= 0 && currentSequence >= 0) return incomingSequence > currentSequence;
        return updatedAtOf(incoming) > updatedAtOf(current || known);
      }
      if (known?.bootIds.has(incomingBoot)) return false;
      return true;
    }
    function remember(hanger) {
      const id = hangerIdOf(hanger);
      if (!id) return;
      const bootId = bootIdOf(hanger);
      const state = states.get(id) || { bootId: null, sequence: -1, bootIds: new Set() };
      if (state.bootId) state.bootIds.add(state.bootId);
      state.bootIds.add(bootId);
      state.bootId = bootId;
      state.sequence = sequenceOf(hanger);
      states.set(id, state);
    }
    function clear() { states.clear(); }
    // app.js keeps the tracker instance in hangerFreshness and calls the
    // identity/status helpers on that instance while merging snapshots.
    // Expose the pure helpers here as well as the tracker state operations so
    // the browser and Node consumers share one complete API.
    return {
      hangerIdOf,
      bootIdOf,
      sequenceOf,
      updatedAtOf,
      clothingStatus,
      isFresher,
      remember,
      clear,
    };
  }

  return { hangerIdOf, bootIdOf, sequenceOf, updatedAtOf, clothingStatus, createTracker };
});
