'use strict';
let token = localStorage.getItem('wardrobeToken'),
  model = { garments: [], hangers: [], gateways: [], events: [], commands: [] },
  simState = { hangers: [], enabled: true },
  simUiState = {},
  outfitRecommendations = [],
  socket,
  retry,
  simTimer = null,
  selected = new Set(),
  currentWeather = null,
  weatherCache = {};

const CITY_COORDS = {
  seoul: { name: '서울', lat: 37.5665, lon: 126.978 },
  busan: { name: '부산', lat: 35.1796, lon: 129.0756 },
  daegu: { name: '대구', lat: 35.8714, lon: 128.6014 },
  incheon: { name: '인천', lat: 37.4563, lon: 126.7052 },
  daejeon: { name: '대전', lat: 36.3504, lon: 127.3845 },
  gwangju: { name: '광주', lat: 35.1595, lon: 126.8526 },
  jeju: { name: '제주', lat: 33.4996, lon: 126.5312 },
};

const $ = s => document.querySelector(s),
  $$ = s => [...document.querySelectorAll(s)],
  esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ----------------- Korean State Label Helper -----------------
function getKoreanState(state) {
  const map = {
    IN_WARDROBE: '옷장 안',
    OUT: '옷장 밖',
    PRESENT: '옷 감지됨',
    EMPTY: '비어 있음',
    OFFLINE: '연결 끊김',
    CONFLICT: '중복 감지',
    UNKNOWN_TAG: '미등록 옷 태그',
    UNSTABLE: '인식 불안정',
    QUEUED: '찾기 요청됨',
    SENT: '찾기 명령 전달됨',
    ACKED: 'LED 점멸 시작됨',
    TIMEOUT: '응답 시간 초과',
  };
  return map[state] || state;
}

async function api(path, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...options.headers,
    },
  });
  const x = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(x.error || `HTTP ${r.status}`);
  return x;
}

function toast(s) {
  $('#toast').textContent = s;
  $('#toast').style.display = 'block';
  setTimeout(() => ($('#toast').style.display = 'none'), 2500);
}

// ----------------- Persistent FIND / LED Active State -----------------
function isHangerLedActive(hangerId) {
  if (!hangerId) return false;
  const simH = (simState.hangers || []).find(h => h.hangerId === hangerId);
  if (simH && Date.now() < (simH.ledUntil || 0)) return true;

  const cmds = (model.commands || []).filter(c => c.targets?.includes(hangerId));
  if (!cmds.length) return false;
  const latest = cmds[0];
  if (latest.command === 'LED_OFF') return false;
  if (['QUEUED', 'SENT', 'ACKED'].includes(latest.status)) {
    const createdAtMs = Date.parse(latest.createdAt || 0);
    const duration = latest.durationMs || 0;
    if (duration === 0) {
      return Date.now() - createdAtMs < 300000; // 5-min safety timeout
    }
    return Date.now() - createdAtMs < duration;
  }
  return false;
}

// ----------------- Image SVG Fallback Placeholder -----------------
function getGarmentSvgPlaceholder(category, color, name) {
  const cat = window.OutfitEngine?.categorizeGarment({ category, name }) || 'top';
  let bg = '#315c49';
  const c = (color || '').toLowerCase();
  if (c.includes('블랙') || c.includes('차콜') || c.includes('black')) bg = '#2c3e50';
  else if (c.includes('화이트') || c.includes('아이보리') || c.includes('크림') || c.includes('white')) bg = '#7f8c8d';
  else if (c.includes('네이비') || c.includes('블루') || c.includes('데님') || c.includes('청') || c.includes('navy')) bg = '#1f3a52';
  else if (c.includes('베이지') || c.includes('브라운') || c.includes('카멜') || c.includes('brown')) bg = '#795548';
  else if (c.includes('그레이') || c.includes('회색') || c.includes('grey') || c.includes('gray')) bg = '#546e7a';
  else if (c.includes('그린') || c.includes('카키') || c.includes('올리브') || c.includes('green')) bg = '#2e7d32';
  else if (c.includes('레드') || c.includes('와인') || c.includes('버건디') || c.includes('red')) bg = '#8e2828';
  else if (c.includes('핑크') || c.includes('pink')) bg = '#ad1457';

  let iconSvg = '';
  if (cat === 'top') {
    iconSvg = '<path d="M50 25 L35 40 L42 47 L47 38 L47 75 L73 75 L73 38 L78 47 L85 40 L70 25 C65 32 55 32 50 25 Z" fill="#ffffff" opacity="0.9"/>';
  } else if (cat === 'bottom') {
    iconSvg = '<path d="M42 25 L78 25 L76 75 L62 75 L60 45 L58 45 L56 75 L44 75 Z" fill="#ffffff" opacity="0.9"/>';
  } else {
    iconSvg = '<path d="M50 22 L30 38 L38 46 L44 36 L44 78 L76 78 L76 36 L82 46 L90 38 L70 22 C64 30 56 30 50 22 Z M59 34 L61 34 L61 78 L59 78 Z" fill="#ffffff" opacity="0.9"/>';
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 100" width="100%" height="100%"><rect width="120" height="100" fill="${bg}"/>${iconSvg}<text x="60" y="90" text-anchor="middle" fill="#ffffff" opacity="0.85" font-size="9" font-family="sans-serif" font-weight="600">${esc(
    name || category || '의류'
  )}</text></svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function formatEvent(e) {
  const atStr = new Date(e.at).toLocaleTimeString();
  const p = e.payload || {};
  switch (e.type) {
    case 'hanger.state': {
      const korState = getKoreanState(p.state);
      const stateBadge = `<span class="pill ${p.state}">${korState}</span>`;
      let note = '';
      if (p.state === 'CONFLICT') note = ' <small class="error" style="display:inline">⚠️ (동일 UID 중복 감지)</small>';
      else if (p.state === 'UNKNOWN_TAG') note = ' <small style="color:var(--amber);display:inline">ℹ️ (미등록 NFC 옷 태그 감지)</small>';
      return `<div><b>${esc(p.alias || p.hangerId)}</b> ${stateBadge} · UID <code>${esc(p.tagUid || '없음')}</code>${note}</div><small class="muted">${atStr}</small>`;
    }
    case 'hanger.offline':
      return `<div><b>${esc(p.alias || p.hangerId)}</b> <span class="pill OFFLINE">${getKoreanState(
        'OFFLINE'
      )}</span> · 30초 이상 신호 없음</div><small class="muted">${atStr}</small>`;
    case 'command.queued':
      return `<div><b>찾기 명령 대기</b> · 대상: <b>${esc((p.targets || []).join(', '))}</b> (${p.command || 'LED_BLINK'})</div><small class="muted">${atStr}</small>`;
    case 'command.ack': {
      const isOff = p.command === 'LED_OFF';
      const text = isOff ? 'LED 소등 확인' : 'LED 점멸 시작됨 (찾는 중)';
      return `<div><b>${text}</b> · 대상: <b>${esc((p.targets || []).join(', '))}</b> <span class="pill PRESENT">${
        p.status === 'ACKED' ? '수신 확인 (ACKED)' : '부분 응답 (PARTIAL)'
      }</span></div><small class="muted">${atStr}</small>`;
    }
    case 'command.timeout':
      return `<div><b>명령 타임아웃</b> · 대상: <b>${esc((p.targets || []).join(', '))}</b> (15초 내 ACK 미수신)</div><small class="error">${atStr}</small>`;
    case 'garment.created':
      return `<div><b>새 옷 등록</b> · "${esc(p.name)}" (UID: <code>${esc(p.tagUid)}</code>)</div><small class="muted">${atStr}</small>`;
    case 'garment.deleted':
      return `<div><b>옷 삭제</b> · ID: <code>${esc(p.id)}</code></div><small class="muted">${atStr}</small>`;
    default:
      return `<div><b>${esc(e.type)}</b> · ${esc(p.hangerId || p.name || '')}</div><small class="muted">${atStr}</small>`;
  }
}

function getMeaningfulEvents(events) {
  const list = [];
  const lastSeenMap = {};
  for (let i = (events || []).length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'hanger.state') {
      const hId = e.payload?.hangerId;
      const key = `${e.payload?.state}_${e.payload?.tagUid || ''}`;
      if (lastSeenMap[hId] === key) continue;
      lastSeenMap[hId] = key;
    }
    list.unshift(e);
  }
  return list;
}

// ----------------- Combobox Helper -----------------
const BASE_CATEGORIES = ['티셔츠', '셔츠', '니트', '후드티', '맨투맨', '블라우스', '가디건', '자켓', '코트', '패딩', '조끼', '청바지', '슬랙스', '면바지', '치노', '반바지', '스커트', '원피스', '트레이닝복', '정장', '기타'];
const BASE_COLORS = ['블랙', '화이트', '그레이', '차콜', '네이비', '블루', '스카이블루', '데님', '베이지', '아이보리', '브라운', '카멜', '카키', '그린', '올리브', '레드', '와인', '버건디', '핑크', '퍼플', '옐로우', '오렌지', '실버', '골드', '멀티컬러', '기타'];
const BASE_SEASONS = ['봄', '여름', '가을', '겨울', '봄/가을', '가을/겨울', '봄/여름', '사계절'];

function getCategorySuggestions() {
  const recent = [...new Set((model.garments || []).map(g => g.category).filter(Boolean))];
  const list = [];
  for (const r of recent) list.push({ text: r, isRecent: true });
  for (const b of BASE_CATEGORIES) if (!recent.includes(b)) list.push({ text: b, isRecent: false });
  return list;
}

function getColorSuggestions() {
  const recent = [...new Set((model.garments || []).map(g => g.color).filter(Boolean))];
  const list = [];
  for (const r of recent) list.push({ text: r, isRecent: true });
  for (const b of BASE_COLORS) if (!recent.includes(b)) list.push({ text: b, isRecent: false });
  return list;
}

function getSeasonSuggestions() {
  return BASE_SEASONS.map(s => ({ text: s, isRecent: false }));
}

function getBrandSuggestions() {
  const recent = [...new Set((model.garments || []).map(g => g.brand).filter(Boolean))];
  const defaultPopular = ['무신사 스탠다드', '유니클로', '나이키', '아디다스', '자라', '스파오', '스투시', '코스', '폴로 랄프로렌'];
  const list = [];
  for (const r of recent) list.push({ text: r, isRecent: true });
  for (const p of defaultPopular) if (!recent.includes(p)) list.push({ text: p, isRecent: false });
  return list;
}

function setupCombobox(wrapId, getItemsFn) {
  const wrap = $(wrapId);
  if (!wrap) return;
  const input = wrap.querySelector('input');
  const arrow = wrap.querySelector('.combobox-arrow');
  const dropdown = wrap.querySelector('.combobox-dropdown');
  if (!input || !dropdown) return;

  let activeIndex = -1;
  let currentFiltered = [];

  function openDropdown(filteredList) {
    currentFiltered = filteredList;
    activeIndex = -1;
    if (!currentFiltered.length) {
      dropdown.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:#7b8b82">일치 항목 없음 (직접 입력 가능)</div>';
      dropdown.hidden = false;
      return;
    }

    dropdown.innerHTML = currentFiltered
      .map(
        (item, idx) => `
      <div class="combobox-item" data-index="${idx}">
        <span>${esc(item.text)}</span>
        ${item.isRecent ? '<span class="badge">최근 사용</span>' : ''}
      </div>`
      )
      .join('');

    dropdown.hidden = false;

    dropdown.querySelectorAll('.combobox-item').forEach(el => {
      el.onmousedown = e => {
        e.preventDefault();
        const idx = Number(el.dataset.index);
        selectItem(currentFiltered[idx]);
      };
    });
  }

  function closeDropdown() {
    dropdown.hidden = true;
    activeIndex = -1;
  }

  function selectItem(item) {
    if (item) input.value = item.text;
    closeDropdown();
  }

  function updateHighlight() {
    const items = dropdown.querySelectorAll('.combobox-item');
    items.forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
      if (i === activeIndex) el.scrollIntoView({ block: 'nearest' });
    });
  }

  input.oninput = () => {
    const all = getItemsFn();
    const filtered = all.filter(it => window.OutfitEngine?.matchQuery(it.text, input.value));
    openDropdown(filtered);
  };

  input.onfocus = () => {
    const all = getItemsFn();
    const filtered = input.value ? all.filter(it => window.OutfitEngine?.matchQuery(it.text, input.value)) : all;
    openDropdown(filtered);
  };

  if (arrow) {
    arrow.onclick = e => {
      e.stopPropagation();
      if (!dropdown.hidden) {
        closeDropdown();
      } else {
        input.focus();
        openDropdown(getItemsFn());
      }
    };
  }

  input.onkeydown = e => {
    if (dropdown.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      openDropdown(getItemsFn());
      return;
    }

    if (!dropdown.hidden) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentFiltered.length > 0) {
          activeIndex = (activeIndex + 1) % currentFiltered.length;
          updateHighlight();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (currentFiltered.length > 0) {
          activeIndex = (activeIndex - 1 + currentFiltered.length) % currentFiltered.length;
          updateHighlight();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0 && currentFiltered[activeIndex]) {
          selectItem(currentFiltered[activeIndex]);
        } else {
          closeDropdown();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeDropdown();
      }
    }
  };

  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) closeDropdown();
  });
}

// ----------------- Single Garment Searchable Combobox -----------------
function getSingleGarmentItems() {
  const inWardrobe = (model.garments || []).filter(g => g.currentState === 'IN_WARDROBE' && g.currentHanger);
  return inWardrobe.map(g => ({
    id: g.id,
    garment: g,
    text: `${g.name} · ${g.category || '의류'} · ${g.color || '미지정'} · ${g.currentHanger}`,
    searchKey: `${g.name} ${g.category || ''} ${g.color || ''} ${g.currentHanger || ''}`,
  }));
}

function setupSingleGarmentCombobox() {
  const wrap = $('#cb_single_garment');
  if (!wrap) return;
  const input = $('#singleGarmentInput');
  const hiddenId = $('#selectedBaseGarmentId');
  const arrow = wrap.querySelector('.combobox-arrow');
  const dropdown = wrap.querySelector('.combobox-dropdown');
  if (!input || !dropdown) return;

  let activeIndex = -1;
  let currentFiltered = [];

  function openDropdown(filteredList) {
    currentFiltered = filteredList;
    activeIndex = -1;
    if (!currentFiltered.length) {
      dropdown.innerHTML = '<div style="padding:8px 12px;font-size:12px;color:#7b8b82">옷장에 검색과 일치하는 옷이 없습니다.</div>';
      dropdown.hidden = false;
      return;
    }

    dropdown.innerHTML = currentFiltered
      .map(
        (item, idx) => `
      <div class="combobox-item" data-index="${idx}">
        <span>${esc(item.text)}</span>
      </div>`
      )
      .join('');

    dropdown.hidden = false;

    dropdown.querySelectorAll('.combobox-item').forEach(el => {
      el.onmousedown = e => {
        e.preventDefault();
        const idx = Number(el.dataset.index);
        selectItem(currentFiltered[idx]);
      };
    });
  }

  function closeDropdown() {
    dropdown.hidden = true;
    activeIndex = -1;
  }

  function selectItem(item) {
    if (item) {
      input.value = item.text;
      if (hiddenId) hiddenId.value = item.id;
      renderSingleGarmentMatches(item.id);
    }
    closeDropdown();
  }

  function updateHighlight() {
    const items = dropdown.querySelectorAll('.combobox-item');
    items.forEach((el, i) => {
      el.classList.toggle('active', i === activeIndex);
      if (i === activeIndex) el.scrollIntoView({ block: 'nearest' });
    });
  }

  input.oninput = () => {
    const all = getSingleGarmentItems();
    const filtered = all.filter(it => window.OutfitEngine?.matchQuery(it.searchKey, input.value));
    openDropdown(filtered);
  };

  input.onfocus = () => {
    const all = getSingleGarmentItems();
    const filtered = input.value ? all.filter(it => window.OutfitEngine?.matchQuery(it.searchKey, input.value)) : all;
    openDropdown(filtered);
  };

  if (arrow) {
    arrow.onclick = e => {
      e.stopPropagation();
      if (!dropdown.hidden) {
        closeDropdown();
      } else {
        input.focus();
        openDropdown(getSingleGarmentItems());
      }
    };
  }

  input.onkeydown = e => {
    if (dropdown.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      openDropdown(getSingleGarmentItems());
      return;
    }

    if (!dropdown.hidden) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (currentFiltered.length > 0) {
          activeIndex = (activeIndex + 1) % currentFiltered.length;
          updateHighlight();
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (currentFiltered.length > 0) {
          activeIndex = (activeIndex - 1 + currentFiltered.length) % currentFiltered.length;
          updateHighlight();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0 && currentFiltered[activeIndex]) {
          selectItem(currentFiltered[activeIndex]);
        } else {
          closeDropdown();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeDropdown();
      }
    }
  };

  document.addEventListener('click', e => {
    if (!wrap.contains(e.target)) closeDropdown();
  });
}

function initAllComboboxes() {
  setupCombobox('#cb_category', getCategorySuggestions);
  setupCombobox('#cb_color', getColorSuggestions);
  setupCombobox('#cb_season', getSeasonSuggestions);
  setupCombobox('#cb_brand', getBrandSuggestions);
  setupSingleGarmentCombobox();
}

// ----------------- Open-Meteo Weather Service -----------------
async function loadWeather(cityKey = 'seoul') {
  const city = CITY_COORDS[cityKey] || CITY_COORDS.seoul;
  const nowMs = Date.now();
  const badge = $('#weatherStatusBadge');

  if (weatherCache[cityKey] && nowMs - weatherCache[cityKey].timestamp < 1200000) {
    currentWeather = weatherCache[cityKey].data;
    renderWeatherBadge(currentWeather, city.name);
    return currentWeather;
  }

  try {
    if (badge) badge.textContent = `☀️ ${city.name} 날씨 조회 중...`;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&current=temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const cur = data.current || {};

    currentWeather = {
      city: city.name,
      temp: cur.temperature_2m,
      apparentTemp: cur.apparent_temperature,
      precipitation: cur.precipitation || 0,
      code: cur.weather_code,
      wind: cur.wind_speed_10m,
    };

    weatherCache[cityKey] = { timestamp: nowMs, data: currentWeather };
    renderWeatherBadge(currentWeather, city.name);
    return currentWeather;
  } catch (err) {
    console.warn('[Weather API Fallback]', err.message);
    currentWeather = null;
    if (badge) {
      badge.textContent = `📍 ${city.name} · 날씨 API 대기 (기본 룰 추천 적용)`;
      badge.style.background = '#fef5e7';
      badge.style.color = '#d35400';
    }
    return null;
  }
}

function getWeatherConditionText(code) {
  if (code === 0) return '맑음 ☀️';
  if ([1, 2, 3].includes(code)) return '구름 조금/흐림 ⛅';
  if ([45, 48].includes(code)) return '안개 🌫️';
  if ([51, 53, 55, 61, 63, 65, 80, 81, 82].includes(code)) return '비 🌧️';
  if ([71, 73, 75, 85, 86].includes(code)) return '눈 ❄️';
  if ([95, 96, 99].includes(code)) return '뇌우 ⚡';
  return '온화한 날씨 🌤️';
}

function renderWeatherBadge(w, cityName) {
  const badge = $('#weatherStatusBadge');
  if (!badge || !w) return;
  const cond = getWeatherConditionText(w.code);
  badge.textContent = `📍 ${cityName} · ${w.temp}°C (체감 ${w.apparentTemp}°C) · ${cond} · 강수 ${w.precipitation}mm`;
  badge.style.background = '#eaf2f8';
  badge.style.color = '#2471a3';
}

// ----------------- Whole Outfit Recommendation UI -----------------
function renderOutfitRecs() {
  const container = $('#outfitRecCards');
  if (!container) return;

  const occasion = $('#occasionSelect')?.value || 'all';
  outfitRecommendations = window.OutfitEngine?.generateWholeOutfits(model.garments, currentWeather, occasion) || [];

  if (!outfitRecommendations.length) {
    container.innerHTML = `
      <article class="panel" style="grid-column:1/-1;text-align:center;padding:24px">
        <h3>💡 코디 추천을 위한 의류가 부족합니다</h3>
        <p class="muted">옷장에 상의(Top)와 하의(Bottom)가 각각 1벌 이상 걸려있어야 코디를 추천할 수 있습니다.</p>
      </article>`;
    return;
  }

  container.innerHTML = outfitRecommendations
    .map((rec, idx) => {
      const isFinding = rec.targets.some(t => isHangerLedActive(t));
      return `
      <article class="card ${isFinding ? 'led-on' : ''}" style="border-top:4px solid var(--green)">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="pill" style="background:#eaf6ee;color:#218451;font-weight:700">추천 #${idx + 1} · ${esc(rec.styleType)}</span>
          <small class="muted">매칭 점수: <b>${rec.displayScore}점</b></small>
        </div>
        <h3 style="margin:8px 0 6px">${esc(rec.title)}</h3>

        <div style="background:#f4f6f4;padding:8px 10px;border-radius:8px;margin-bottom:10px;font-size:12px;color:#335c4a">
          <b>💡 추천 근거:</b><br>
          ${rec.reasons.map(r => `• ${esc(r)}`).join('<br>')}
        </div>

        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:12px">
          ${rec.items
            .map(
              item => `
            <div style="display:flex;justify-content:space-between;align-items:center;background:#f8faf8;padding:6px 10px;border-radius:8px;border:1px solid #e7ede7;font-size:13px">
              <div>
                <b>${esc(item.name)}</b>
                <span class="muted">(${esc(item.category || '의류')}, ${esc(item.color || '색상 미지정')})</span>
              </div>
              <span class="pill PRESENT" style="font-size:11px">${esc(item.currentHanger)}</span>
            </div>
          `
            )
            .join('')}
        </div>

        <div style="display:flex;gap:6px">
          <button onclick="findOutfit(['${rec.targets.join("','")}'], '${esc(rec.title)}')" style="flex:1">
            ${isFinding ? '다시 찾기 (동시 점멸)' : `🎯 이 코디 옷 찾기 (${rec.targets.length}개 옷걸이)`}
          </button>
          ${
            isFinding
              ? `<button onclick="stopOutfit(['${rec.targets.join("','")}'])" class="ghost" style="color:var(--red);border:1px solid #e78e88">LED 끄기</button>`
              : ''
          }
        </div>
      </article>
    `;
    })
    .join('');
}

// ----------------- Single-Garment Matching Ranking UI -----------------
function renderSingleGarmentMatches(baseGarmentId) {
  const container = $('#singleMatchResults');
  if (!container) return;

  if (!baseGarmentId) {
    container.innerHTML = '<p class="muted" style="grid-column:1/-1;text-align:center;padding:16px">위 검색창에서 기준이 될 옷을 검색하고 선택하세요.</p>';
    return;
  }

  const base = (model.garments || []).find(g => g.id === baseGarmentId);
  if (!base || base.currentState !== 'IN_WARDROBE') {
    container.innerHTML = '<p class="error" style="grid-column:1/-1">선택한 옷이 옷장 안에 없습니다.</p>';
    return;
  }

  const occasion = $('#occasionSelect')?.value || 'all';
  const matches = window.OutfitEngine?.generateSingleGarmentMatches(baseGarmentId, model.garments, currentWeather, occasion) || [];

  if (!matches.length) {
    container.innerHTML = '<p class="muted" style="grid-column:1/-1">함께 매칭할 다른 옷이 옷장에 없습니다.</p>';
    return;
  }

  container.innerHTML = matches
    .map((m, idx) => {
      const isFinding = m.targets.some(t => isHangerLedActive(t));
      return `
      <article class="card ${isFinding ? 'led-on' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span class="pill PRESENT" style="font-weight:700">순위 #${idx + 1} · ${esc(m.garment.category || '의류')}</span>
          <small class="muted">매칭 점수: <b>${m.displayScore}점</b></small>
        </div>
        <h3 style="margin:8px 0 4px">${esc(base.name)} + ${esc(m.garment.name)}</h3>
        <p class="muted" style="font-size:12px;margin-bottom:8px">위치: <b>${esc(m.garment.currentHanger)}</b> · 색상: ${esc(m.garment.color || '미지정')}</p>

        <div style="background:#f4f6f4;padding:8px 10px;border-radius:8px;margin-bottom:10px;font-size:12px;color:#335c4a">
          <b>💡 매칭 포인트:</b><br>
          ${m.reasons.map(r => `• ${esc(r)}`).join('<br>')}
        </div>

        <div style="display:flex;gap:6px">
          <button onclick="findOutfit(['${m.targets.join("','")}'], '${esc(base.name)} + ${esc(m.garment.name)}')" style="flex:1;font-size:13px;padding:8px">
            🎯 이 조합 찾기 (2벌 동시 점멸)
          </button>
          ${
            isFinding
              ? `<button onclick="stopOutfit(['${m.targets.join("','")}'])" class="ghost" style="color:var(--red);border:1px solid #e78e88;font-size:12px;padding:7px">LED 끄기</button>`
              : ''
          }
        </div>
      </article>
    `;
    })
    .join('');
}

// ----------------- Chat-Style Outfit Assistant -----------------
function handleChatAssistant(userQuery) {
  const respBox = $('#chatAssistantResponse');
  if (!respBox) return;

  const result = window.OutfitEngine?.processChatQuery(userQuery, model.garments, currentWeather);
  if (!result) return;

  respBox.style.display = 'block';

  if (!result.recommendations.length) {
    respBox.innerHTML = `
      <div style="font-size:14px;color:var(--ink)">
        <b>🤖 코디 어시스턴트:</b><br>
        "현재 옷장에 코디를 조합할 수 있는 상·하의 의류가 충분하지 않습니다. 새 옷을 등록하거나 옷걸이에 옷을 걸어주세요."
      </div>
    `;
    return;
  }

  const best = result.recommendations[0];
  const occLabel = {
    business: '비즈니스 / 출근',
    campus: '캠퍼스 / 등교',
    date: '데이트 / 약속',
    workout: '운동 / 산책',
    casual: '편안한 일상',
    all: '데일리',
  }[result.inferredOccasion];

  respBox.innerHTML = `
    <div style="font-size:14px;line-height:1.6;color:var(--ink)">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span class="pill" style="background:#eaf6ee;color:#218451;font-weight:700">🤖 코디 어시스턴트 추천</span>
        <span class="muted" style="font-size:12px">분석 상황: <b>${esc(occLabel)}</b></span>
      </div>
      <p style="margin:4px 0 10px">
        "요청하신 상황(<b>${esc(occLabel)}</b>)과 현재 날씨를 분석하여 옷장에서 가장 알맞은 조합을 찾았습니다!"
      </p>
      <div style="background:#ffffff;border:1px solid #cbd4cd;border-radius:10px;padding:12px;margin-bottom:10px">
        <h4 style="margin:0 0 6px">${esc(best.title)} <span class="pill PRESENT">${best.displayScore}점</span></h4>
        <div style="font-size:12px;color:#456b57;margin-bottom:8px">
          ${best.reasons.map(r => `• ${esc(r)}`).join('<br>')}
        </div>
        <div style="display:flex;gap:6px">
          <button onclick="findOutfit(['${best.targets.join("','")}'], '${esc(best.title)}')" style="flex:1">
            🎯 이 코디 옷 찾기 (${best.targets.join(', ')})
          </button>
          <button onclick="stopOutfit(['${best.targets.join("','")}'])" class="ghost" style="color:var(--red);border:1px solid #e78e88">LED 끄기</button>
        </div>
      </div>
    </div>
  `;
}

// ----------------- Public FIND / STOP Actions -----------------
window.findGarment = async (id, hangerId) => {
  if (!hangerId) {
    toast('옷장 밖(OUT) 상태인 옷은 LED를 점멸할 수 없습니다.');
    return;
  }
  try {
    await api('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ targets: [hangerId], command: 'LED_BLINK', durationMs: 0 }),
    });
    toast(`[찾기 시작] ${hangerId} 옷걸이에 LED 지속 점멸 명령을 전송했습니다.`);
    refresh();
  } catch (x) {
    toast(`[찾기 오류] ${x.message}`);
  }
};

window.stopGarment = async hangerId => {
  if (!hangerId) return;
  try {
    await api('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ targets: [hangerId], command: 'LED_OFF' }),
    });
    toast(`[LED 끄기] ${hangerId} 옷걸이의 LED를 소등했습니다.`);
    refresh();
  } catch (x) {
    toast(`[소등 오류] ${x.message}`);
  }
};

window.findOutfit = async (targets, title) => {
  if (!targets || !targets.length) return;
  try {
    await api('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ targets, command: 'LED_BLINK', durationMs: 0 }),
    });
    toast(`[코디 찾기] ${targets.join(', ')} 옷걸이에 동시 LED 점멸 명령을 전송했습니다.`);
    refresh();
  } catch (x) {
    toast(`[코디 찾기 오류] ${x.message}`);
  }
};

window.stopOutfit = async targets => {
  if (!targets || !targets.length) return;
  try {
    await api('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ targets, command: 'LED_OFF' }),
    });
    toast(`[코디 LED 끄기] ${targets.join(', ')} 옷걸이의 LED를 소등했습니다.`);
    refresh();
  } catch (x) {
    toast(`[소등 오류] ${x.message}`);
  }
};

window.findOne = async id => {
  const g = (model.garments || []).find(x => x.id === id);
  if (g && g.currentHanger) {
    return window.findGarment(id, g.currentHanger);
  }
  toast('옷장 안에 없는 옷입니다.');
};

window.deleteGarment = async (id, name) => {
  if (!confirm(`정말로 "${name}" 옷을 삭제하시겠습니까?\n(등록 정보가 삭제되며, 해당 옷걸이의 태그는 미등록 옷 태그로 전환됩니다.)`)) return;
  try {
    await api(`/api/garments/${id}`, { method: 'DELETE' });
    toast(`"${name}" 옷을 삭제했습니다.`);
    refresh();
  } catch (e) {
    toast(`[삭제 오류] ${e.message}`);
  }
};

function render() {
  const h = model.hangers || [],
    g = model.garments || [],
    online = (model.gateways || []).some(x => Date.now() - Date.parse(x.lastSeen || 0) < 30000),
    counts = [
      ['전체 옷', g.length],
      ['옷장 안', g.filter(x => x.currentState === 'IN_WARDROBE').length],
      ['옷 감지됨', h.filter(x => x.state === 'PRESENT').length],
      ['비어 있음', h.filter(x => x.state === 'EMPTY').length],
      ['연결 끊김', h.filter(x => x.state === 'OFFLINE').length],
      ['경고/중복', h.filter(x => ['UNSTABLE', 'CONFLICT', 'UNKNOWN_TAG'].includes(x.state)).length],
    ];

  $('#summary').innerHTML = counts.map(x => `<article><b>${x[1]}</b><span>${x[0]}</span></article>`).join('');

  const garment = x => {
    const isFinding = isHangerLedActive(x.currentHanger);
    const korState = getKoreanState(x.currentState);
    const findingBadge = isFinding
      ? `<span class="pill" style="background:#fef5e7;color:#d35400;border:1px solid #f39c12;font-weight:700">🔍 찾는 중 · ${esc(
          x.currentHanger
        )} (점멸 중)</span>`
      : '';

    const fallbackSrc = getGarmentSvgPlaceholder(x.category, x.color, x.name);
    const imgSrc = x.imageUrl ? esc(x.imageUrl) : fallbackSrc;

    return `<article class="card ${isFinding ? 'led-on' : ''}">
      <img src="${imgSrc}" onerror="this.onerror=null;this.src='${fallbackSrc}'" alt="">
      <h3>${esc(x.name)}</h3>
      <p>${esc(x.category || '미분류')} · ${esc(x.color || '색상 미지정')}</p>
      <span class="pill ${x.currentState}">${korState}</span> ${findingBadge}
      <small class="muted" style="display:block;margin-top:4px">${esc(x.currentHanger || '옷장 밖')} · UID <code>${esc(x.tagUid)}</code></small>
      <div class="actions">
        ${
          isFinding
            ? `<button onclick="findGarment('${x.id}', '${x.currentHanger}')">다시 찾기</button>
               <button class="ghost" style="color:var(--red);border:1px solid #e78e88" onclick="stopGarment('${x.currentHanger}')">LED 끄기</button>`
            : `<button ${x.currentHanger ? '' : 'disabled'} onclick="findGarment('${x.id}', '${x.currentHanger}')">LED 찾기</button>`
        }
        <button class="ghost" style="color:var(--red);border:1px solid #e78e88;padding:7px 11px;font-size:12px" onclick="deleteGarment('${x.id}', '${esc(
      x.name
    )}')">삭제</button>
      </div>
    </article>`;
  };

  $('#recentGarments').innerHTML = g.slice(0, 6).map(garment).join('') || '<p class="muted">새 옷을 등록하세요.</p>';

  const q = $('#search').value.toLowerCase(),
    sf = $('#stateFilter').value;
  $('#garments').innerHTML =
    g
      .filter(x => (!q || [x.name, x.category, x.color, x.brand].join(' ').toLowerCase().includes(q)) && (!sf || x.currentState === sf))
      .map(garment)
      .join('') || '<p>조건에 맞는 옷이 없습니다.</p>';

  const hq = ($('#hangerSearch')?.value || '').toLowerCase(),
    hf = $('#hangerFilter')?.value || '';

  const filteredHangers = h.filter(x => {
    const isOnline = Date.now() - Date.parse(x.lastSeen || 0) < 30000;
    if (hq && ![x.hangerId, x.alias, x.tagUid, x.state].join(' ').toLowerCase().includes(hq)) return false;
    if (hf === 'ONLINE') return isOnline;
    if (hf === 'OFFLINE') return !isOnline || x.state === 'OFFLINE';
    if (hf === 'CONFLICT') return ['CONFLICT', 'UNKNOWN_TAG', 'UNSTABLE'].includes(x.state);
    if (hf === 'VIRTUAL') return /^HC-00000[1-5]$/.test(x.hangerId);
    if (hf === 'PRESENT' || hf === 'EMPTY') return x.state === hf;
    return true;
  });

  $('#hangerCards').innerHTML =
    filteredHangers
      .map(x => {
        let stateDesc = '';
        if (x.state === 'CONFLICT') {
          stateDesc = '<p class="error" style="font-size:12px;margin:3px 0">⚠️ 동일 UID가 다른 옷걸이에서도 중복 감지됨</p>';
        } else if (x.state === 'UNKNOWN_TAG') {
          stateDesc = '<p style="color:var(--amber);font-size:12px;margin:3px 0">ℹ️ 미등록 NFC 옷 태그 감지됨 (새 옷 등록 가능)</p>';
        }
        const isOnline = Date.now() - Date.parse(x.lastSeen || 0) < 30000;
        const isLedOn = isHangerLedActive(x.hangerId);

        return `<article class="card ${isLedOn ? 'led-on' : ''}">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h3>${esc(x.alias || x.hangerId)}</h3>
            <div>
              <span class="pill ${x.state}">${getKoreanState(x.state)}</span>
              ${isLedOn ? '<span class="sim-led-badge on" style="margin-left:4px">💡 LED 점멸 중</span>' : ''}
            </div>
          </div>
          ${stateDesc}
          <p style="margin:6px 0">UID: <b>${esc(x.tagUid || '없음')}</b></p>
          <small class="muted">
            상태: <b>${isOnline ? '🟢 온라인' : '🔴 연결 끊김'}</b> · 채널 ${x.channel || '-'} · RSSI ${x.rssi || '-'}<br>
            ${x.lastSeen ? new Date(x.lastSeen).toLocaleString() : '신호 없음'}<br>
            FW ${esc(x.firmwareVersion)} · Seq ${x.lastSequence || 0}
          </small>
          ${
            isLedOn
              ? `<div style="margin-top:10px">
                  <button class="ghost" style="color:var(--red);border:1px solid #e78e88;width:100%;font-size:12px;padding:6px" onclick="stopGarment('${x.hangerId}')">LED 끄기</button>
                </div>`
              : ''
          }
        </article>`;
      })
      .join('') || '<p>조건에 맞는 옷걸이가 없습니다.</p>';

  $('#outfitCards').innerHTML =
    g
      .filter(x => x.currentState === 'IN_WARDROBE')
      .map(
        x =>
          `<article class="card selectable ${selected.has(x.currentHanger) ? 'selected' : ''}" data-hanger="${esc(x.currentHanger)}"><h3>${esc(
            x.name
          )}</h3><p>${esc(x.category || '미분류')} · ${esc(x.currentHanger)}</p><span class="pill">${
            selected.has(x.currentHanger) ? '선택됨' : '눌러서 선택'
          }</span></article>`
      )
      .join('') || '<p>현재 옷장 안에 있는 옷이 없습니다.</p>';

  const cleanEvents = getMeaningfulEvents(model.events || []);

  $('#recentEvents').innerHTML =
    cleanEvents
      .slice(0, 8)
      .map(e => `<li>${formatEvent(e)}</li>`)
      .join('') || '<li>이벤트 없음</li>';

  $('#allEvents').innerHTML =
    cleanEvents
      .slice(0, 100)
      .map(e => `<li>${formatEvent(e)}</li>`)
      .join('') || '<li>이벤트 없음</li>';

  $('#diagnostics').innerHTML = [
    ['서버', 'ONLINE'],
    ['게이트웨이', online ? 'ONLINE' : 'OFFLINE'],
    ['실시간 연결', socket?.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED'],
    ['명령 대기', (model.commands || []).filter(c => !['ACKED', 'TIMEOUT'].includes(c.status)).length],
  ]
    .map(x => `<article class="panel"><small>${x[0]}</small><h3>${x[1]}</h3></article>`)
    .join('');

  $$('.selectable').forEach(
    x =>
      (x.onclick = () => {
        selected.has(x.dataset.hanger) ? selected.delete(x.dataset.hanger) : selected.add(x.dataset.hanger);
        render();
      })
  );

  updateDetectedTags();
  renderSim();
}

async function refresh() {
  model = await api('/api/snapshot');
  render();
  fetchSimState();
}

function connect() {
  clearTimeout(retry);
  socket?.close();
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${encodeURIComponent(token)}`);
  socket.onopen = () => {
    $('#connection').textContent = '실시간 연결됨';
    $('#dot').className = 'on';
    render();
  };
  socket.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'snapshot') {
      model = m.payload;
      render();
    } else {
      refresh();
    }
  };
  socket.onclose = () => {
    $('#connection').textContent = '재연결 중';
    $('#dot').className = '';
    retry = setTimeout(connect, 2000);
  };
}

let currentAuthMode = 'login',
  isInitialSetup = false;

function setAuthMode(mode, setup) {
  currentAuthMode = mode || 'login';
  if (setup !== undefined) isInitialSetup = setup;
  $('#authForm').dataset.mode = currentAuthMode;
  $('#authError').textContent = '';
  const successBox = $('#authSuccess');
  if (successBox) successBox.style.display = 'none';

  const nameGrp = $('#authNameGroup'),
    nameInput = $('#authName'),
    submitBtn = $('#authSubmit'),
    toggleBtn = $('#authToggle');

  if (currentAuthMode === 'signup') {
    $('#authTitle').textContent = isInitialSetup ? '첫 관리자 만들기' : '회원가입';
    if (nameGrp) nameGrp.style.display = 'block';
    if (nameInput) nameInput.required = true;
    if (submitBtn) submitBtn.textContent = isInitialSetup ? '관리자 등록 및 시작' : '회원가입';
    if (toggleBtn) {
      toggleBtn.textContent = '이미 계정이 있으신가요? 로그인';
      toggleBtn.style.display = isInitialSetup ? 'none' : 'block';
    }
  } else {
    $('#authTitle').textContent = '로그인';
    if (nameGrp) nameGrp.style.display = 'none';
    if (nameInput) nameInput.required = false;
    if (submitBtn) submitBtn.textContent = '로그인';
    if (toggleBtn) {
      toggleBtn.textContent = '계정이 없으신가요? 회원가입';
      toggleBtn.style.display = 'block';
    }
  }
}

function switchView(viewName) {
  const targetView = viewName || 'dashboard';
  $$('nav button').forEach(x => x.classList.toggle('active', x.dataset.view === targetView));
  $$('.view').forEach(v => (v.hidden = v.id !== targetView));
  if (targetView === 'outfit') {
    renderOutfitRecs();
  } else if (targetView === 'simulation') {
    fetchSimState();
    if (!simTimer) simTimer = setInterval(fetchSimState, 1500);
  } else {
    if (simTimer) {
      clearInterval(simTimer);
      simTimer = null;
    }
  }
}

async function enter() {
  try {
    await refresh();
    $('#auth').hidden = true;
    $('#auth').style.display = 'none';
    $('#app').hidden = false;
    $('#app').style.display = 'block';
    switchView('dashboard');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    connect();
    loadWeather($('#weatherCitySelect')?.value || 'seoul');
  } catch (err) {
    console.error('Enter error:', err);
    localStorage.removeItem('wardrobeToken');
    token = null;
    showAuth();
  }
}

async function showAuth() {
  try {
    const s = await api('/api/auth/status');
    setAuthMode(s.setupRequired ? 'signup' : 'login', !!s.setupRequired);
  } catch {
    setAuthMode('login', false);
  }
  $('#auth').hidden = false;
  $('#auth').style.display = 'grid';
  $('#app').hidden = true;
  $('#app').style.display = 'none';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateDetectedTags() {
  const select = $('#detectedTagSelect');
  if (!select) return;

  const currentVal = select.value;
  const unknownHangers = (model.hangers || []).filter(h => h.state === 'UNKNOWN_TAG' && h.tagUid);

  if (!unknownHangers.length) {
    select.innerHTML = '<option value="">-- 현재 감지된 미등록 옷 태그 없음 (직접 입력) --</option>';
    return;
  }

  const formatTimeAgo = iso => {
    if (!iso) return '방금 감지';
    const diffSec = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
    if (diffSec < 10) return '방금 감지';
    if (diffSec < 60) return `${diffSec}초 전 감지`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}분 전 감지`;
    return new Date(iso).toLocaleTimeString();
  };

  select.innerHTML = [
    `<option value="">-- 미등록 옷 태그 선택 (${unknownHangers.length}개 감지됨) --</option>`,
    ...unknownHangers.map(h => {
      const timeStr = formatTimeAgo(h.lastSeen);
      return `<option value="${esc(h.tagUid)}">${esc(h.tagUid)} · ${esc(h.alias || h.hangerId)} · ${timeStr}</option>`;
    }),
  ].join('');

  if (currentVal && unknownHangers.some(h => h.tagUid === currentVal)) {
    select.value = currentVal;
  }
}

const detectedTagSel = $('#detectedTagSelect');
if (detectedTagSel) {
  detectedTagSel.onchange = function () {
    if (this.value) {
      const uidInput = $('#garmentUid');
      if (uidInput) uidInput.value = this.value;
      const formErr = $('#formError');
      if (formErr) formErr.textContent = '';
    }
  };
}

// ----------------- Simulation Panel Logic -----------------
async function fetchSimState() {
  if (!token) return;
  try {
    const res = await api('/api/dev/simulation');
    simState.enabled = res.enabled !== false;
    simState.hangers = res.hangers || [];
    renderSim();
  } catch (e) {
    if (e.message.includes('404')) {
      simState.enabled = false;
      const navSim = $('#navSim');
      if (navSim) navSim.style.display = 'none';
    }
  }
}

function renderSim() {
  const container = $('#simCards');
  if (!container) return;
  const list = simState.hangers || [];
  if (!list.length) {
    container.innerHTML = '<p class="muted">가상 하드웨어 상태를 불러오는 중입니다...</p>';
    return;
  }

  const garments = model.garments || [];

  const existingCards = $$('.sim-card');
  if (existingCards.length === list.length && existingCards.length > 0) {
    list.forEach(h => {
      const card = container.querySelector(`[data-hanger="${h.hangerId}"]`);
      if (!card) return;
      const isLedOn = Date.now() < (h.ledUntil || 0);

      if (isLedOn && h.ledUntil) {
        const remaining = Math.max(50, h.ledUntil - Date.now() + 50);
        setTimeout(() => renderSim(), remaining);
      }

      card.className = `card sim-card ${h.isOnline ? '' : 'offline'} ${isLedOn ? 'led-on' : ''}`;

      const pill = card.querySelector('.sim-header .pill');
      if (pill) {
        pill.className = `pill ${h.state}`;
        pill.textContent = getKoreanState(h.state);
      }
      const ledBadge = card.querySelector('.sim-led-badge');
      if (ledBadge) {
        ledBadge.className = `sim-led-badge ${isLedOn ? 'on' : 'off'}`;
        ledBadge.textContent = isLedOn ? '💡 LED 점멸 중' : 'LED OFF';
      }

      const meta = card.querySelector('.sim-meta');
      if (meta) {
        meta.innerHTML = `태그 UID: <b>${esc(h.tagUid || '(none)')}</b><br>
          하트비트: <b>${h.isOnline ? '🟢 온라인' : '🔴 중단 (OFFLINE 대기)'}</b><br>
          ACK 모드: <b>${esc(h.ackMode || 'OK')}</b> · Seq: ${h.seq} · Boot: ${esc(h.bootId || '-')}
          ${h.lastCommandId ? `<br>최근 명령 ID: <code>${h.lastCommandId}</code>` : ''}`;
      }

      const gSel = card.querySelector('.sim-garment-select');
      if (gSel) {
        const curVal = simUiState[h.hangerId]?.garmentUid || gSel.value;
        const optionsHtml = [
          '<option value="">-- 옷을 선택하면 UID가 입력됩니다 --</option>',
          ...garments.map(g => `<option value="${esc(g.tagUid)}" ${curVal === g.tagUid ? 'selected' : ''}>${esc(g.name)} (UID: ${esc(g.tagUid)})</option>`),
        ].join('');
        if (gSel.innerHTML !== optionsHtml) {
          gSel.innerHTML = optionsHtml;
          if (curVal) gSel.value = curVal;
        }
      }

      const ackSel = card.querySelector('.sim-ack-select');
      if (ackSel) {
        const curAck = simUiState[h.hangerId]?.ackMode || h.ackMode || 'OK';
        if (ackSel.value !== curAck) ackSel.value = curAck;
      }
    });
    return;
  }

  container.innerHTML = list
    .map(h => {
      const isLedOn = Date.now() < (h.ledUntil || 0);
      if (isLedOn && h.ledUntil) {
        const remaining = Math.max(50, h.ledUntil - Date.now() + 50);
        setTimeout(() => renderSim(), remaining);
      }
      const localUi = simUiState[h.hangerId] || {};
      const curGarmentUid = localUi.garmentUid || '';
      const curTypedUid = localUi.typedUid !== undefined ? localUi.typedUid : h.tagUid && h.tagUid !== '(none)' ? h.tagUid : '';
      const curAck = localUi.ackMode || h.ackMode || 'OK';

      return `
      <article class="card sim-card ${h.isOnline ? '' : 'offline'} ${isLedOn ? 'led-on' : ''}" data-hanger="${h.hangerId}">
        <div class="sim-header">
          <h3>${h.hangerId}</h3>
          <span class="pill ${h.state}">${getKoreanState(h.state)}</span>
          ${isLedOn ? '<span class="sim-led-badge on">💡 LED 점멸 중</span>' : '<span class="sim-led-badge off">LED OFF</span>'}
        </div>

        <div class="sim-meta">
          태그 UID: <b>${esc(h.tagUid || '(none)')}</b><br>
          하트비트: <b>${h.isOnline ? '🟢 온라인' : '🔴 중단 (OFFLINE 대기)'}</b><br>
          ACK 모드: <b>${esc(h.ackMode || 'OK')}</b> · Seq: ${h.seq} · Boot: ${esc(h.bootId || '-')}
          ${h.lastCommandId ? `<br>최근 명령 ID: <code>${h.lastCommandId}</code>` : ''}
        </div>

        <label style="font-size:12px;margin:2px 0 0;font-weight:600">등록된 옷 선택 (UID 자동채움)
          <select class="sim-garment-select" data-hanger="${h.hangerId}" style="font-size:12px;padding:6px 8px;margin-top:3px">
            <option value="">-- 옷을 선택하면 UID가 입력됩니다 --</option>
            ${garments
              .map(g => `<option value="${esc(g.tagUid)}" ${curGarmentUid === g.tagUid ? 'selected' : ''}>${esc(g.name)} (UID: ${esc(g.tagUid)})</option>`)
              .join('')}
          </select>
        </label>

        <label style="font-size:12px;margin:2px 0 0;font-weight:600">NTAG213 UID (옷 태그)
          <input type="text" id="sim_uid_${h.hangerId}" class="sim-uid-input" data-hanger="${h.hangerId}" placeholder="14자리 HEX UID" value="${esc(
        curTypedUid
      )}" style="font-size:12px;padding:7px 8px;margin-top:3px">
        </label>

        <div class="sim-btn-row">
          <button class="sim-act" data-action="tag-insert" data-hanger="${h.hangerId}">태그 삽입</button>
          <button class="sim-act sub" data-action="tag-remove" data-hanger="${h.hangerId}">태그 분리</button>
          <button class="sim-act sub" data-action="tag-change" data-hanger="${h.hangerId}">태그 교체</button>
        </div>

        <label style="font-size:12px;margin:4px 0 0;font-weight:600">ACK 응답 모드
          <select class="sim-ack-select" data-hanger="${h.hangerId}" style="font-size:12px;padding:6px 8px;margin-top:3px">
            <option value="OK" ${curAck === 'OK' ? 'selected' : ''}>정상 ACK (OK)</option>
            <option value="ERROR" ${curAck === 'ERROR' ? 'selected' : ''}>ERROR ACK</option>
            <option value="IGNORE" ${curAck === 'IGNORE' ? 'selected' : ''}>ACK 무시 (IGNORE - 15초 타임아웃 유도)</option>
          </select>
        </label>

        <div class="sim-btn-row">
          <button class="sim-act sub" data-action="online" data-hanger="${h.hangerId}">온라인</button>
          <button class="sim-act sub" data-action="offline" data-hanger="${h.hangerId}">오프라인</button>
          <button class="sim-act sub" data-action="duplicate" data-hanger="${h.hangerId}">중복 패킷</button>
        </div>
      </article>
    `;
    })
    .join('');

  $$('.sim-garment-select').forEach(sel => {
    sel.onchange = () => {
      const hId = sel.dataset.hanger;
      if (!simUiState[hId]) simUiState[hId] = {};
      simUiState[hId].garmentUid = sel.value;
      simUiState[hId].typedUid = sel.value;

      const targetInput = $(`#sim_uid_${hId}`);
      if (targetInput && sel.value) targetInput.value = sel.value;
    };
  });

  $$('.sim-uid-input').forEach(inp => {
    inp.oninput = () => {
      const hId = inp.dataset.hanger;
      if (!simUiState[hId]) simUiState[hId] = {};
      simUiState[hId].typedUid = inp.value;
    };
  });

  $$('.sim-ack-select').forEach(sel => {
    sel.onchange = async () => {
      const hId = sel.dataset.hanger;
      const mode = sel.value;
      if (!simUiState[hId]) simUiState[hId] = {};
      simUiState[hId].ackMode = mode;
      await execSimAction('ack-mode', hId, null, mode);
    };
  });

  $$('.sim-act').forEach(btn => {
    btn.onclick = async () => {
      const action = btn.dataset.action;
      const hId = btn.dataset.hanger;
      const uidInput = $(`#sim_uid_${hId}`);
      const tagUid = uidInput ? uidInput.value.trim() : null;

      if ((action === 'tag-insert' || action === 'tag-change') && !tagUid) {
        toast(`[오류] ${hId}에 삽입할 UID를 입력하거나 등록된 옷을 선택해주세요.`);
        return;
      }
      await execSimAction(action, hId, tagUid);
    };
  });
}

async function execSimAction(action, hangerId, tagUid = null, mode = null) {
  try {
    const res = await api('/api/dev/simulation/action', {
      method: 'POST',
      body: JSON.stringify({ action, hangerId, tagUid, mode }),
    });
    simState.hangers = res.hangers || [];
    render();
    toast(`[시뮬레이터] ${hangerId} ${action} 완료`);
  } catch (err) {
    toast(`[시뮬레이터 오류] ${err.message}`);
  }
}

// ----------------- Garment image picker -----------------
const garmentImageState = {
  requestId: 0,
  originalPreviewUrl: '',
  processedUrl: '',
  processing: false,
};

function revokeGarmentPreview() {
  if (garmentImageState.originalPreviewUrl.startsWith('blob:')) {
    URL.revokeObjectURL(garmentImageState.originalPreviewUrl);
  }
  garmentImageState.originalPreviewUrl = '';
}

function setGarmentImageStatus(text, state = '') {
  const status = $('#garmentImageStatus');
  if (!status) return;
  status.textContent = text;
  status.className = `garment-image-status${state ? ` is-${state}` : ''}`;
}

function applyGarmentClassification(predictions) {
  const fields = [
    ['category', '#garmentCategory', BASE_CATEGORIES],
    ['color', '#garmentColor', BASE_COLORS],
    ['season', '#garmentSeason', BASE_SEASONS],
  ];

  for (const [key, selector, allowedValues] of fields) {
    const input = $(selector);
    const top = String(predictions?.[key]?.top || '').trim();
    if (input && allowedValues.includes(top)) input.value = top;
  }
}

async function classifyGarmentImage(blob, requestId) {
  const form = new FormData();
  form.append('image', blob, 'wardrobe-cutout.png');
  const response = await fetch('/api/dev/background-removal/classify', {
    method: 'POST',
    body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (requestId !== garmentImageState.requestId) return null;
  if (!response.ok) throw new Error(result.error || '옷 정보 자동 분류에 실패했습니다.');
  applyGarmentClassification(result.predictions);
  return result;
}

function resetGarmentImage() {
  garmentImageState.requestId += 1;
  garmentImageState.processing = false;
  garmentImageState.processedUrl = '';
  revokeGarmentPreview();

  const fileInput = $('#garmentImageInput');
  const imageUrl = $('#garmentImageUrl');
  const preview = $('#garmentImagePreview');
  const previewImg = $('#garmentImagePreviewImg');
  const submitBtn = $('#garmentSubmit');
  if (fileInput) fileInput.value = '';
  if (imageUrl) imageUrl.value = '';
  if (preview) preview.hidden = true;
  if (previewImg) previewImg.removeAttribute('src');
  if (submitBtn) submitBtn.disabled = false;
  setGarmentImageStatus('사진을 선택하면 배경을 자동으로 제거합니다.');
}

async function processGarmentImage(file) {
  const formErr = $('#formError');
  const submitBtn = $('#garmentSubmit');
  const imageUrl = $('#garmentImageUrl');
  const preview = $('#garmentImagePreview');
  const previewImg = $('#garmentImagePreviewImg');
  if (!file) return resetGarmentImage();

  const allowed = ['image/jpeg', 'image/png', 'image/webp'];
  if ((!allowed.includes(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name)) || file.size > 12 * 1024 * 1024) {
    if (formErr) formErr.textContent = file.size > 12 * 1024 * 1024 ? '사진은 12MB 이하로 선택해주세요.' : 'JPG, PNG, WEBP 사진만 선택할 수 있습니다.';
    resetGarmentImage();
    setGarmentImageStatus(file.size > 12 * 1024 * 1024 ? '파일 용량 초과' : '지원하지 않는 사진 형식입니다.', 'error');
    return;
  }

  const requestId = ++garmentImageState.requestId;
  revokeGarmentPreview();
  garmentImageState.processing = true;
  garmentImageState.processedUrl = '';
  if (imageUrl) imageUrl.value = '';
  const originalUrl = URL.createObjectURL(file);
  garmentImageState.originalPreviewUrl = originalUrl;
  if (previewImg) previewImg.src = originalUrl;
  if (preview) preview.hidden = false;
  if (submitBtn) submitBtn.disabled = true;
  ['#garmentCategory', '#garmentColor', '#garmentSeason'].forEach(selector => {
    const input = $(selector);
    if (input) input.value = '';
  });
  setGarmentImageStatus('BiRefNet Lite로 배경을 제거하는 중입니다… 잠시만 기다려주세요.', 'working');

  let uploadedImageReady = false;
  try {
    const form = new FormData();
    form.append('image', file, file.name);
    const response = await fetch('/api/garments/image', {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: form,
    });
    const result = await response.json().catch(() => ({}));
    if (requestId !== garmentImageState.requestId) return;
    if (!response.ok) throw new Error(result.error || '사진 배경 제거에 실패했습니다.');

    garmentImageState.processedUrl = result.imageUrl || '';
    if (!garmentImageState.processedUrl) throw new Error('처리된 사진 주소를 받지 못했습니다.');
    if (imageUrl) imageUrl.value = garmentImageState.processedUrl;
    if (previewImg) previewImg.src = `${garmentImageState.processedUrl}?v=${Date.now()}`;
    revokeGarmentPreview();
    uploadedImageReady = true;

    const processedResponse = await fetch(`${garmentImageState.processedUrl}?v=${Date.now()}`, { cache: 'no-store' });
    if (!processedResponse.ok) throw new Error('처리된 사진을 불러오지 못했습니다.');
    const processedBlob = await processedResponse.blob();
    if (requestId !== garmentImageState.requestId) return;
    setGarmentImageStatus('배경 제거 완료 · 자동 분류 중입니다…', 'working');
    await classifyGarmentImage(processedBlob, requestId);
    if (requestId !== garmentImageState.requestId) return;

    garmentImageState.processing = false;
    if (submitBtn) submitBtn.disabled = false;
    setGarmentImageStatus('배경 제거 및 자동 분류 완료', 'ready');
  } catch (err) {
    if (requestId !== garmentImageState.requestId) return;
    garmentImageState.processing = false;
    if (uploadedImageReady) {
      if (submitBtn) submitBtn.disabled = false;
      if (formErr) formErr.textContent = err.message || '옷 정보 자동 분류에 실패했습니다.';
      setGarmentImageStatus('배경 제거 완료 · 자동 분류 실패', 'error');
      return;
    }
    garmentImageState.processedUrl = '';
    if (imageUrl) imageUrl.value = '';
    if (submitBtn) submitBtn.disabled = false;
    if (formErr) formErr.textContent = err.message || '사진 배경 제거에 실패했습니다.';
    setGarmentImageStatus('배경 제거에 실패했습니다. 다른 사진으로 다시 시도해주세요.', 'error');
  }
}

function setupGarmentImagePicker() {
  if (!document.querySelector('link[href^="/garment-image.css"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = '/garment-image.css?v=1';
    document.head.append(link);
  }

  const legacyInput = document.querySelector('#garmentForm input[name="imageUrl"]');
  const legacyLabel = legacyInput?.closest('label');
  if (!legacyInput || !legacyLabel) return;

  const field = document.createElement('div');
  field.className = 'garment-image-field';
  field.innerHTML = `
    <span class="image-field-title">옷 사진</span>
    <div class="garment-image-picker">
      <input id="garmentImageInput" type="file" accept="image/jpeg,image/png,image/webp" hidden>
      <label class="image-picker-button" for="garmentImageInput">앨범에서 사진 선택</label>
      <span id="garmentImageStatus" class="garment-image-status">사진을 선택하면 배경을 자동으로 제거합니다.</span>
    </div>
    <input id="garmentImageUrl" name="imageUrl" type="hidden">
    <span id="garmentImagePreview" class="garment-image-preview" hidden>
      <img id="garmentImagePreviewImg" alt="배경이 제거된 옷 미리보기">
      <button id="clearGarmentImage" type="button" class="ghost image-clear-button">사진 지우기</button>
  </span>`;
  legacyLabel.replaceWith(field);
  const form = document.querySelector('#garmentForm');
  const title = form?.querySelector('.title');
  if (title) title.insertAdjacentElement('afterend', field);

  $('#garmentImageInput').onchange = e => processGarmentImage(e.target.files?.[0]);
  $('#clearGarmentImage').onclick = () => resetGarmentImage();
  resetGarmentImage();
}

// ----------------- Form Submission & Event Listeners -----------------
$('#authToggle').onclick = () => setAuthMode(currentAuthMode === 'login' ? 'signup' : 'login', false);

$('#authForm').onsubmit = async e => {
  e.preventDefault();
  $('#authError').textContent = '';
  const successBox = $('#authSuccess');
  if (successBox) successBox.style.display = 'none';

  const submitBtn = $('#authSubmit');
  submitBtn.disabled = true;

  try {
    const mode = e.target.dataset.mode || currentAuthMode || 'login';
    const x = Object.fromEntries(new FormData(e.target));
    const r = await api('/api/auth/' + mode, { method: 'POST', body: JSON.stringify(x) });
    token = r.token;
    localStorage.setItem('wardrobeToken', token);

    if (successBox) {
      successBox.textContent = mode === 'signup' ? '✓ 회원가입 완료' : '✓ 로그인 완료';
      successBox.style.display = 'block';
    }

    setTimeout(async () => {
      await enter();
      submitBtn.disabled = false;
      if (successBox) successBox.style.display = 'none';
    }, 650);
  } catch (x) {
    submitBtn.disabled = false;
    $('#authError').textContent = x.message;
  }
};

setupGarmentImagePicker();

$$('[data-open-garment]').forEach(x =>
  (x.onclick = () => {
    const formErr = $('#formError');
    const successBox = $('#garmentSuccess');
    if (formErr) formErr.textContent = '';
    if (successBox) successBox.style.display = 'none';
    const form = $('#garmentForm');
    if (form) form.reset();
    resetGarmentImage();
    updateDetectedTags();
    $('#garmentDialog').showModal();
  })
);

$('#closeDialog').onclick = () => $('#garmentDialog').close();

$('#garmentForm').onsubmit = async e => {
  e.preventDefault();
  const formErr = $('#formError');
  const successBox = $('#garmentSuccess');
  if (formErr) formErr.textContent = '';
  if (successBox) successBox.style.display = 'none';

  if (garmentImageState.processing) {
    if (formErr) formErr.textContent = '사진 처리와 자동 분류가 끝날 때까지 기다려주세요.';
    return;
  }

  const formData = Object.fromEntries(new FormData(e.target));
  const rawName = String(formData.name || '').trim();
  const rawUid = String(formData.tagUid || '').trim();

  if (!rawName) {
    if (formErr) formErr.textContent = '옷 이름을 입력해주세요.';
    return;
  }

  if (!rawUid) {
    if (formErr) formErr.textContent = 'NTAG213 UID(옷 태그)를 입력해주세요.';
    return;
  }

  const normalizedUid = rawUid.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (!/^[0-9A-F]{14}$/.test(normalizedUid)) {
    if (formErr) {
      formErr.innerHTML = 'UID는 14자리 HEX 형식으로 입력해주세요.<br><small style="color:var(--ink)">예: 04A10000000001 (또는 04 A1 00 00 00 00 01)</small>';
    }
    return;
  }

  const payload = {
    ...formData,
    name: rawName,
    tagUid: normalizedUid,
    category: String(formData.category || '').trim(),
    color: String(formData.color || '').trim(),
    season: String(formData.season || '').trim(),
    brand: String(formData.brand || '').trim(),
  };

  const submitBtn = $('#garmentSubmit');
  if (submitBtn) submitBtn.disabled = true;

  try {
    await api('/api/garments', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (successBox) {
      successBox.textContent = '✓ 옷 등록 완료';
      successBox.style.display = 'block';
    }

    setTimeout(() => {
      e.target.reset();
      resetGarmentImage();
      if (successBox) successBox.style.display = 'none';
      if (submitBtn) submitBtn.disabled = false;
      $('#garmentDialog').close();
      toast('옷을 등록했습니다.');
      refresh();
    }, 600);
  } catch (x) {
    if (submitBtn) submitBtn.disabled = false;
    if (formErr) {
      if (x.message.includes('UID 중복')) {
        formErr.textContent = '이미 다른 옷에 등록된 UID입니다.';
      } else {
        formErr.textContent = x.message;
      }
    }
  }
};

$('#multiFind').onclick = async () => {
  if (!selected.size) {
    toast('선택된 옷걸이가 없습니다. 아래에서 옷을 눌러 선택해주세요.');
    return;
  }
  try {
    await api('/api/commands', {
      method: 'POST',
      body: JSON.stringify({ targets: [...selected], command: 'LED_BLINK', durationMs: 0 }),
    });
    toast(`${selected.size}개 옷걸이에 LED 점멸 명령을 전송했습니다.`);
    selected.clear();
    render();
  } catch (x) {
    toast(x.message);
  }
};

const outfitRecBtn = $('#getOutfitRecBtn');
if (outfitRecBtn) {
  outfitRecBtn.onclick = () => {
    renderOutfitRecs();
    toast('옷장 안의 의류와 날씨·상황에 맞춘 최적 코디를 추천했습니다.');
  };
}

const citySel = $('#weatherCitySelect');
if (citySel) {
  citySel.onchange = async () => {
    await loadWeather(citySel.value);
    renderOutfitRecs();
    const curBase = $('#selectedBaseGarmentId')?.value;
    if (curBase) renderSingleGarmentMatches(curBase);
  };
}

const occSel = $('#occasionSelect');
if (occSel) {
  occSel.onchange = () => {
    renderOutfitRecs();
    const curBase = $('#selectedBaseGarmentId')?.value;
    if (curBase) renderSingleGarmentMatches(curBase);
  };
}

const chatForm = $('#chatOutfitForm');
if (chatForm) {
  chatForm.onsubmit = e => {
    e.preventDefault();
    const input = $('#chatOutfitInput');
    if (input) handleChatAssistant(input.value);
  };
}

$('#search').oninput = render;
$('#stateFilter').onchange = render;

const hangerSearchInp = $('#hangerSearch');
if (hangerSearchInp) hangerSearchInp.oninput = render;

const hangerFilterSel = $('#hangerFilter');
if (hangerFilterSel) hangerFilterSel.onchange = render;

const simRefreshBtn = $('#simRefresh');
if (simRefreshBtn) {
  simRefreshBtn.onclick = () => {
    fetchSimState();
    toast('시뮬레이션 상태를 새로고침했습니다.');
  };
}

const simResetBtn = $('#simResetBtn');
if (simResetBtn) {
  simResetBtn.onclick = async () => {
    if (!confirm('가상 옷걸이 및 시뮬레이션 테스트 데이터를 초기화할까요?\n실제 등록 의류/실물 장치 데이터는 삭제하지 않습니다.')) return;
    try {
      await api('/api/dev/simulation/reset', { method: 'POST' });
      simUiState = {};
      toast('시뮬레이션 데이터를 초기화했습니다.');
      refresh();
    } catch (err) {
      toast(`[초기화 오류] ${err.message}`);
    }
  };
}

setInterval(() => {
  const hasActiveLeds =
    (simState.hangers || []).some(h => Date.now() < (h.ledUntil || 0)) ||
    (model.commands || []).some(c => ['QUEUED', 'SENT', 'ACKED'].includes(c.status));
  if (hasActiveLeds) {
    render();
  }
}, 1000);

$$('nav button').forEach(b => (b.onclick = () => switchView(b.dataset.view)));

$('#logout').onclick = () => {
  if (simTimer) {
    clearInterval(simTimer);
    simTimer = null;
  }
  socket?.close();
  localStorage.removeItem('wardrobeToken');
  token = null;
  showAuth();
};

initAllComboboxes();
token ? enter() : showAuth();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
