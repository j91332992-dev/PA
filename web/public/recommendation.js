/**
 * Pure Deterministic Outfit Recommendation Engine
 * Can be run in Node.js backend or browser client without DOM dependencies.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.OutfitEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CHOSUNG = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

  function getChosung(str) {
    let res = '';
    for (let i = 0; i < (str || '').length; i++) {
      const code = str.charCodeAt(i) - 0xac00;
      if (code >= 0 && code <= 11171) res += CHOSUNG[Math.floor(code / 588)];
      else res += str[i];
    }
    return res;
  }

  function matchQuery(target, query) {
    if (!query) return true;
    const t = String(target || '').toLowerCase();
    const q = String(query || '').trim().toLowerCase();
    if (t.includes(q)) return true;
    const tCho = getChosung(t);
    const qCho = getChosung(q);
    if (tCho.includes(qCho) || tCho.includes(q)) return true;
    return false;
  }

  function categorizeGarment(g) {
    const text = `${g?.category || ''} ${g?.name || ''}`.toLowerCase();
    if (['아우터', '자켓', '재킷', '코트', '패딩', '가디건', '블레이저', '점퍼', '집업', '조끼', 'outer', 'jacket', 'coat', 'cardigan', 'padding'].some(k => text.includes(k)))
      return 'outer';
    if (['하의', '바지', '팬츠', '슬랙스', '청바지', '데님', '치노', '스커트', '반바지', '면바지', 'pants', 'bottom', 'slacks', 'jeans', 'skirt', 'shorts'].some(k => text.includes(k)))
      return 'bottom';
    return 'top';
  }

  function calculateColorScore(c1, c2) {
    c1 = (c1 || '').toLowerCase();
    c2 = (c2 || '').toLowerCase();
    if (!c1 || !c2) return { score: 6, reason: '단정한 기본 컬러 매칭' };
    if (c1 === c2) return { score: 7, reason: '세련된 모노크롬 톤온톤' };
    const neutral = ['화이트', '블랙', '그레이', '차콜', '회색', 'white', 'black', 'grey', 'gray'];
    if (neutral.some(n => c1.includes(n)) || neutral.some(n => c2.includes(n))) {
      return { score: 10, reason: '무채색과 유채색의 깔끔한 안정적 조화' };
    }
    if ((c1.includes('네이비') || c1.includes('navy')) && (c2.includes('베이지') || c2.includes('beige') || c2.includes('데님') || c2.includes('청'))) {
      return { score: 10, reason: '네이비와 베이지/데님의 클래식 보색 대비' };
    }
    if ((c1.includes('베이지') || c1.includes('beige')) && (c2.includes('브라운') || c2.includes('brown') || c2.includes('카키') || c2.includes('khaki'))) {
      return { score: 9, reason: '어스(Earth) 톤의 따뜻하고 차분한 조화' };
    }
    return { score: 7, reason: '자연스러운 데일리 컬러 밸런스' };
  }

  function evaluateOccasionScore(items, occasion) {
    let bonus = 0;
    const reasons = [];
    const text = items.map(g => `${g.name} ${g.category || ''}`).join(' ').toLowerCase();

    switch (occasion) {
      case 'business':
        if (['셔츠', '슬랙스', '자켓', '블레이저', '정장', '코트'].some(k => text.includes(k))) {
          bonus += 18;
          reasons.push('단정하고 격식 있는 비즈니스/출근 룩에 적합');
        }
        break;
      case 'campus':
        if (['후드', '맨투맨', '청바지', '데님', '티셔츠', '치노'].some(k => text.includes(k))) {
          bonus += 18;
          reasons.push('활동적이고 편안한 캠퍼스/등교 룩에 적합');
        }
        break;
      case 'date':
        if (['니트', '셔츠', '코트', '슬랙스', '가디건', '원피스'].some(k => text.includes(k))) {
          bonus += 18;
          reasons.push('깔끔하고 세련된 데이트/약속 룩에 적합');
        }
        break;
      case 'workout':
        if (['트레이닝', '운동', '조거', '반바지', '기능성', '티셔츠'].some(k => text.includes(k))) {
          bonus += 18;
          reasons.push('가볍고 쾌적한 운동/산책 룩에 적합');
        }
        break;
      default:
        bonus += 5;
        reasons.push('일상에서 부담 없이 입기 좋은 데일리 스타일');
        break;
    }
    return { bonus, reasons };
  }

  function evaluateWeatherScore(items, weather) {
    let bonus = 0;
    const reasons = [];
    if (!weather) return { bonus: 0, reasons: [] };

    const hasOuter = items.some(g => categorizeGarment(g) === 'outer');
    const temp = weather.temp;

    if (temp <= 10) {
      if (hasOuter) {
        bonus += 20;
        reasons.push(`쌀쌀한 기온(${temp}°C)에 맞는 따뜻한 아우터 레이어드`);
      } else {
        bonus -= 12;
      }
    } else if (temp > 10 && temp <= 22) {
      bonus += 12;
      reasons.push(`온화한 간절기 기온(${temp}°C)에 쾌적한 코디`);
    } else if (temp > 22) {
      if (hasOuter) {
        bonus -= 18;
      } else {
        bonus += 12;
        reasons.push(`따뜻한 기온(${temp}°C)에 알맞은 가벼운 상·하의 구성`);
      }
    }

    if (weather.precipitation > 0) {
      const bottom = items.find(g => categorizeGarment(g) === 'bottom');
      if (bottom && (bottom.color?.includes('화이트') || bottom.color?.includes('아이보리'))) {
        bonus -= 8;
      } else {
        bonus += 8;
        reasons.push('비 오는 날씨를 고려한 빗물 오염 방지 컬러 매칭');
      }
    }

    return { bonus, reasons };
  }

  /**
   * Normalizes raw score to strict 0 ~ 100 range for user display
   */
  function normalizeDisplayScore(rawScore, minRaw = 40, maxRaw = 100) {
    if (rawScore >= maxRaw) {
      const overflow = rawScore - maxRaw;
      return Math.min(100, Math.round(95 + Math.min(5, overflow * 0.25)));
    }
    const ratio = Math.max(0, (rawScore - minRaw) / (maxRaw - minRaw));
    return Math.min(94, Math.max(50, Math.round(50 + ratio * 44)));
  }

  /**
   * Generate Whole Outfit Recommendations (Top 1~3)
   */
  function generateWholeOutfits(garments, weather = null, occasion = 'all') {
    const inWardrobe = (garments || []).filter(g => g.currentState === 'IN_WARDROBE' && g.currentHanger);
    if (inWardrobe.length < 2) return [];

    const tops = inWardrobe.filter(g => categorizeGarment(g) === 'top');
    const bottoms = inWardrobe.filter(g => categorizeGarment(g) === 'bottom');
    const outers = inWardrobe.filter(g => categorizeGarment(g) === 'outer');

    const candidates = [];

    // 1. Top + Bottom
    for (const top of tops) {
      for (const bottom of bottoms) {
        let rawScore = 50;
        const reasons = [];

        const colorEval = calculateColorScore(top.color, bottom.color);
        rawScore += colorEval.score;
        reasons.push(colorEval.reason);

        if (top.season && bottom.season && (top.season === bottom.season || top.season === '사계절' || bottom.season === '사계절')) {
          rawScore += 8;
          reasons.push(`계절감 일치 (${top.season === bottom.season ? top.season : '사계절'})`);
        }

        const occEval = evaluateOccasionScore([top, bottom], occasion);
        rawScore += occEval.bonus;
        reasons.push(...occEval.reasons);

        const wEval = evaluateWeatherScore([top, bottom], weather);
        rawScore += wEval.bonus;
        reasons.push(...wEval.reasons);

        candidates.push({
          title: `${top.name} + ${bottom.name}`,
          styleType: '데일리 투피스 코디',
          rawScore,
          displayScore: normalizeDisplayScore(rawScore),
          reasons: reasons.slice(0, 3),
          items: [top, bottom],
          targets: [top.currentHanger, bottom.currentHanger],
        });

        // 2. Top + Bottom + Outer
        for (const outer of outers) {
          let outerRawScore = 58;
          const outerReasons = [];

          const c1 = calculateColorScore(top.color, bottom.color);
          const c2 = calculateColorScore(top.color, outer.color);
          outerRawScore += Math.floor((c1.score + c2.score) / 2);
          outerReasons.push(c1.reason);

          if (outer.season && (outer.season === top.season || outer.season === '사계절')) {
            outerRawScore += 8;
            outerReasons.push('아우터와 이너의 계절 일치');
          }

          const occOuterEval = evaluateOccasionScore([top, bottom, outer], occasion);
          outerRawScore += occOuterEval.bonus;
          outerReasons.push(...occOuterEval.reasons);

          const wOuterEval = evaluateWeatherScore([top, bottom, outer], weather);
          outerRawScore += wOuterEval.bonus;
          outerReasons.push(...wOuterEval.reasons);

          candidates.push({
            title: `${outer.name} + ${top.name} + ${bottom.name}`,
            styleType: '레이어드 포멀/캐주얼 코디',
            rawScore: outerRawScore,
            displayScore: normalizeDisplayScore(outerRawScore),
            reasons: outerReasons.slice(0, 3),
            items: [outer, top, bottom],
            targets: [outer.currentHanger, top.currentHanger, bottom.currentHanger],
          });
        }
      }
    }

    candidates.sort((a, b) => b.rawScore - a.rawScore);
    return candidates.slice(0, 3);
  }

  /**
   * Generate Single-Garment Matching Ranking
   */
  function generateSingleGarmentMatches(baseGarmentId, garments, weather = null, occasion = 'all') {
    const base = (garments || []).find(g => g.id === baseGarmentId);
    if (!base || base.currentState !== 'IN_WARDROBE') return [];

    const baseCat = categorizeGarment(base);
    const inWardrobe = (garments || []).filter(g => g.currentState === 'IN_WARDROBE' && g.id !== base.id && g.currentHanger);

    const matches = inWardrobe.map(g => {
      let rawScore = 50;
      const reasons = [];
      const targetCat = categorizeGarment(g);

      const cEval = calculateColorScore(base.color, g.color);
      rawScore += cEval.score;
      reasons.push(cEval.reason);

      if (base.season && g.season && (base.season === g.season || base.season === '사계절' || g.season === '사계절')) {
        rawScore += 8;
        reasons.push(`계절감 일치 (${base.season === g.season ? base.season : '사계절'})`);
      }

      if ((baseCat === 'top' && targetCat === 'bottom') || (baseCat === 'bottom' && targetCat === 'top')) {
        rawScore += 18;
        reasons.push('상·하의 기본 매칭 조합');
      } else if (targetCat === 'outer' && (baseCat === 'top' || baseCat === 'bottom')) {
        rawScore += 14;
        reasons.push('아우터 레이어드 조합');
      }

      const occEval = evaluateOccasionScore([base, g], occasion);
      rawScore += occEval.bonus;
      reasons.push(...occEval.reasons);

      const wEval = evaluateWeatherScore([base, g], weather);
      rawScore += wEval.bonus;
      reasons.push(...wEval.reasons);

      return {
        garment: g,
        targetCat,
        rawScore,
        displayScore: normalizeDisplayScore(rawScore),
        reasons: reasons.slice(0, 3),
        targets: [base.currentHanger, g.currentHanger],
      };
    });

    matches.sort((a, b) => b.rawScore - a.rawScore);
    return matches;
  }

  /**
   * Process Natural Language Chat Query and produce structured recommendations
   */
  function processChatQuery(userQuery, garments, weather = null) {
    const q = String(userQuery || '').trim().toLowerCase();
    if (!q) return null;

    let inferredOccasion = 'all';
    if (['출근', '회사', '발표', '정장', '단정', '격식', '면접', '미팅', '오피스'].some(k => q.includes(k))) inferredOccasion = 'business';
    else if (['학교', '대학', '수업', '캠퍼스', '시험', '등교'].some(k => q.includes(k))) inferredOccasion = 'campus';
    else if (['데이트', '약속', '소개팅', '식사', '모임', '파티'].some(k => q.includes(k))) inferredOccasion = 'date';
    else if (['운동', '헬스', '조깅', '산책', '러닝', '트레이닝'].some(k => q.includes(k))) inferredOccasion = 'workout';
    else if (['편하', '집', '동네', '마실', '쉬'].some(k => q.includes(k))) inferredOccasion = 'casual';

    const recs = generateWholeOutfits(garments, weather, inferredOccasion);
    return {
      query: userQuery,
      inferredOccasion,
      recommendations: recs,
    };
  }

  return {
    matchQuery,
    getChosung,
    categorizeGarment,
    calculateColorScore,
    normalizeDisplayScore,
    generateWholeOutfits,
    generateSingleGarmentMatches,
    processChatQuery,
  };
});
