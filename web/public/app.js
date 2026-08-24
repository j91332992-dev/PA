'use strict';
const SENSITIVE_QUERY_KEYS = new Set(['name', 'email', 'password', 'token', 'refresh_token', 'refreshToken', 'adminSecondaryPassword']);
function removeCredentialQuery() {
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEYS.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (changed) history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
removeCredentialQuery();
let token = localStorage.getItem('wardrobeToken'),
  adminSession = sessionStorage.getItem('wardrobeAdminSession') || '',
  model = { garments: [], hangers: [], gateways: [], events: [], commands: [] },
  simState = { hangers: [], enabled: true },
  simUiState = {},
  outfitRecommendations = [],
  socket,
  retry,
  simTimer = null,
  selected = new Set(),
  currentWeather = null,
  weatherCache = {},
  refreshGeneration = 0,
  refreshInFlight = null,
  refreshQueued = false,
  refreshTimer = null,
  sessionUser = null;

const hangerFreshness = window.HangerFreshness.createTracker();

const BLE_SERVICE_UUID = 'a4e66a10-0fb0-4dce-8be0-18cf7bc82001'; // 옷봉
const BLE_CONFIG_UUID = 'a4e66a11-0fb0-4dce-8be0-18cf7bc82001';
const BLE_STATUS_UUID = 'a4e66a12-0fb0-4dce-8be0-18cf7bc82001';
const HANGER_BLE_SERVICE_UUID = 'a4e66a20-0fb0-4dce-8be0-18cf7bc82001';
const HANGER_BLE_CONFIG_UUID = 'a4e66a21-0fb0-4dce-8be0-18cf7bc82001';
const HANGER_BLE_STATUS_UUID = 'a4e66a22-0fb0-4dce-8be0-18cf7bc82001';
let bleConfigCharacteristic = null;
let nearbyWifiNetworks = [];
let hangerBleConfigCharacteristic = null;
const claimedDeviceIds = new Set();
const ROD_RECONNECT_WINDOW_MS = 30000;
let rodReconnectStartedAt = Number(sessionStorage.getItem('wardrobeRodReconnectStartedAt') || 0);

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
const setHTML = (selector, value) => {
  const element = $(selector);
  if (!element) throw new Error(`화면 요소를 찾지 못했습니다: ${selector}`);
  element.innerHTML = value;
};

function hangerDisplayName(hanger) {
  if (!hanger) return '옷걸이';
  if (hanger.alias && hanger.alias !== hanger.hangerId && !/^HC-/i.test(hanger.alias)) return hanger.alias;
  if (!hanger.gatewayId) return `미연결 옷걸이 · ${String(hanger.hangerId || '').slice(-6) || 'UNKNOWN'}`;
  if (Number(hanger.hangerNumber) > 0) return `${Number(hanger.hangerNumber)}번 옷걸이`;
  if (/^HC-00000[1-5]$/i.test(hanger.hangerId || '')) return hanger.alias || hanger.hangerId;
  const physical = (model.hangers || [])
    .filter(item => !/^HC-00000[1-5]$/i.test(item.hangerId || ''))
    .sort((a, b) => Date.parse(a.createdAt || a.lastSeen || 0) - Date.parse(b.createdAt || b.lastSeen || 0));
  const number = Math.max(0, physical.findIndex(item => item.hangerId === hanger.hangerId)) + 1;
  return `${number || 1}번 옷걸이`;
}

function ownerDisplayName() {
  return String(model.wardrobe?.name || '내').replace(/의 스마트 옷장$/, '') || '내';
}

function nextHangerDisplayName() {
  // BLE advertising is intentionally hardware-neutral. The server assigns
  // the user-visible number only after a successful claim.
  return '';
}

function garmentNameForTag(tagUid) {
  return (model.garments || []).find(garment => garment.tagUid === tagUid)?.name || '';
}

function hangerClothingStatus(hanger) {
  return hangerFreshness.clothingStatus(hanger, model.garments);
}

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
      ...(adminSession ? { 'x-admin-session': adminSession } : {}),
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
    case 'command.cancelled':
      return `<div><b>태그 제거로 LED 찾기 종료</b> · 대상: <b>${esc((p.targets || []).join(', '))}</b></div><small class="muted">${atStr}</small>`;
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
  if (sessionUser?.role === 'admin' && sessionUser.adminVerified) {
    renderAdminShellView();
    return;
  }
  const h = model.hangers || [],
    g = model.garments || [],
    online = physicalGatewayStatus().online,
    counts = [
      ['전체 옷', g.length],
      ['옷장 안', g.filter(x => x.currentState === 'IN_WARDROBE').length],
      ['옷 감지됨', h.filter(x => x.state === 'PRESENT').length],
      ['비어 있음', h.filter(x => x.state === 'EMPTY').length],
      ['연결 끊김', h.filter(x => x.state === 'OFFLINE').length],
      ['경고/중복', h.filter(x => ['UNSTABLE', 'CONFLICT', 'UNKNOWN_TAG'].includes(x.state)).length],
    ];

  setHTML('#summary', counts.map(x => `<article><b>${x[1]}</b><span>${x[0]}</span></article>`).join(''));

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
      ${x.imageProcessingStatus === 'processing' ? '<small class="muted" style="display:block;margin:3px 0">사진 처리 중…</small>' : x.imageProcessingStatus === 'failed' ? '<small class="error" style="display:block;margin:3px 0">사진 처리 실패 · 기본 이미지를 표시합니다.</small>' : ''}
      <span class="pill ${x.currentState}">${korState}</span> ${findingBadge}
      <small class="muted" style="display:block;margin-top:4px">${esc(x.currentHanger || '옷장 밖')} · UID <code>${esc(x.tagUid)}</code></small>
      <div class="actions">
        ${
          isFinding
            ? `<button onclick="findGarment('${x.id}', '${x.currentHanger}')">다시 찾기</button>
               <button class="ghost" style="color:var(--red);border:1px solid #e78e88" onclick="stopGarment('${x.currentHanger}')">LED 끄기</button>`
            : `<button ${x.currentHanger ? '' : 'disabled'} onclick="findGarment('${x.id}', '${x.currentHanger}')">${x.currentHanger ? 'LED 찾기' : 'LED 찾기 · 옷장 밖'}</button>`
        }
        <button class="ghost" style="color:var(--red);border:1px solid #e78e88;padding:7px 11px;font-size:12px" onclick="deleteGarment('${x.id}', '${esc(
      x.name
    )}')">삭제</button>
      </div>
    </article>`;
  };

  setHTML('#recentGarments', g.slice(0, 6).map(garment).join('') || '<p class="muted">새 옷을 등록하세요.</p>');

  const q = $('#search').value.toLowerCase(),
    sf = $('#stateFilter').value;
  setHTML('#garments',
    g
      .filter(x => (!q || [x.name, x.category, x.color, x.brand].join(' ').toLowerCase().includes(q)) && (!sf || x.currentState === sf))
      .map(garment)
      .join('') || '<p>조건에 맞는 옷이 없습니다.</p>');

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

  setHTML('#hangerCards',
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
            <h3>${esc(hangerDisplayName(x))}</h3>
            <div>
              <span class="pill ${x.state}">${getKoreanState(x.state)}</span>
              ${isLedOn ? '<span class="sim-led-badge on" style="margin-left:4px">💡 LED 점멸 중</span>' : ''}
            </div>
          </div>
          ${stateDesc}
          <p style="margin:6px 0"><b>${esc(hangerClothingStatus(x))}</b></p>
          <small class="muted">
            상태: <b>${isOnline ? '🟢 온라인' : '🔴 연결 끊김'}</b> · 채널 ${x.channel || '-'} · RSSI ${x.rssi || '-'}<br>
            ${x.lastSeen ? new Date(x.lastSeen).toLocaleString() : '신호 없음'}<br>
            진단 ID ${esc(x.hangerId)} · FW ${esc(x.firmwareVersion)}
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
      .join('') || '<p>조건에 맞는 옷걸이가 없습니다.</p>');

  const cleanEvents = getMeaningfulEvents(model.events || []);

  setHTML('#recentEvents',
    cleanEvents
      .slice(0, 8)
      .map(e => `<li>${formatEvent(e)}</li>`)
      .join('') || '<li>이벤트 없음</li>');

  setHTML('#allEvents',
    cleanEvents
      .slice(0, 100)
      .map(e => `<li>${formatEvent(e)}</li>`)
      .join('') || '<li>이벤트 없음</li>');

  setHTML('#diagnostics', [
    ['서버', 'ONLINE'],
    ['게이트웨이', online ? 'ONLINE' : 'OFFLINE'],
    ['실시간 연결', socket?.readyState === 1 ? 'CONNECTED' : 'DISCONNECTED'],
    ['명령 대기', (model.commands || []).filter(c => !['ACKED', 'TIMEOUT'].includes(c.status)).length],
  ]
    .map(x => `<article class="panel"><small>${x[0]}</small><h3>${x[1]}</h3></article>`)
    .join(''));

  $$('.selectable').forEach(
    x =>
      (x.onclick = () => {
        selected.has(x.dataset.hanger) ? selected.delete(x.dataset.hanger) : selected.add(x.dataset.hanger);
        render();
      })
  );

  updateDetectedTags();
  renderDeviceManagement();
}

function mergeSnapshot(snapshot) {
  const incomingHangers = Array.isArray(snapshot?.hangers) ? snapshot.hangers : [];
  const currentById = new Map((model.hangers || []).map(h => [hangerFreshness.hangerIdOf(h), h]));
  const mergedIds = new Set();
  const hangers = incomingHangers.map(incoming => {
    const id = hangerFreshness.hangerIdOf(incoming);
    const current = currentById.get(id);
    mergedIds.add(id);
    if (current && !hangerFreshness.isFresher(incoming, current)) return current;
    hangerFreshness.remember(incoming);
    return incoming;
  });

  // A snapshot may have been captured before a live event added a hanger.
  // Keep that live record until a newer event/snapshot supersedes it.
  for (const current of model.hangers || []) {
    const id = hangerFreshness.hangerIdOf(current);
    if (id && !mergedIds.has(id)) hangers.push(current);
  }
  return { ...snapshot, hangers };
}

function applyHangerEvent(hanger) {
  const id = hangerFreshness.hangerIdOf(hanger);
  if (!id) return false;
  const current = (model.hangers || []).find(item => hangerFreshness.hangerIdOf(item) === id);
  if (current && !hangerFreshness.isFresher(hanger, current)) return false;
  hangerFreshness.remember(hanger);
  const idx = (model.hangers || []).findIndex(item => hangerFreshness.hangerIdOf(item) === id);
  if (idx >= 0) model.hangers[idx] = hanger;
  else (model.hangers = model.hangers || []).push(hanger);
  return true;
}

function scheduleRefresh(delay = 120) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refresh();
  }, delay);
}

async function refresh() {
  if (sessionUser?.role === 'admin' && sessionUser.adminVerified) return refreshAdminData();
  if (refreshInFlight) {
    refreshQueued = true;
    return refreshInFlight;
  }

  const generation = ++refreshGeneration;
  const request = (async () => {
    const snapshot = await api('/api/snapshot');
    if (generation !== refreshGeneration) return;
    model = mergeSnapshot(snapshot);
    render();
  })();
  refreshInFlight = request;
  try {
    await request;
  } finally {
    if (refreshInFlight === request) refreshInFlight = null;
    if (refreshQueued) {
      refreshQueued = false;
      scheduleRefresh(0);
    }
  }
}

function connect() {
  if (sessionUser?.role === 'admin' && sessionUser.adminVerified) return;
  clearTimeout(retry);
  socket?.close();
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, [`wardrobe-token.${token}`]);
  socket.onopen = () => {
    $('#connection').textContent = '실시간 연결됨';
    $('#dot').className = 'on';
    render();
  };
  socket.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'snapshot') {
      model = mergeSnapshot(m.payload);
      render();
    } else if (m.type === 'hanger.state') {
      const h = m.payload;
      if (!applyHangerEvent(h)) return;
      // WebSocket events do not arrive through refresh(), so keep the recent
      // event feed in sync with the same live state update.
      model.events = model.events || [];
      model.events.unshift({ type: 'hanger.state', payload: h, at: m.at || new Date().toISOString() });
      model.events = model.events.slice(0, 1000);
      for (const g of (model.garments || [])) {
        const found = (model.hangers || []).find(x => x.tagUid === g.tagUid && x.state === 'PRESENT');
        g.currentState = found ? 'IN_WARDROBE' : 'OUT';
        g.currentHanger = found ? found.hangerId : null;
      }
      render();
    } else {
      // Heartbeats and command/garment events can arrive in bursts. Coalesce
      // them instead of starting one full snapshot request per message.
      scheduleRefresh();
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
  }
  if (simTimer) {
    clearInterval(simTimer);
    simTimer = null;
  }
}

async function enter() {
  try {
    sessionUser = (await api('/api/auth/status')).user || null;
    if (!sessionUser) throw Error('로그인 정보를 확인할 수 없습니다.');
    if (sessionUser.role === 'admin') {
      const adminStatus = await api('/api/admin/status');
      sessionUser.adminVerified = !!adminStatus.verified;
      if (!sessionUser.adminVerified) {
        showAdminSecondFactor();
        return;
      }
      hideAdminSecondFactor();
      $('#auth').hidden = true;
      $('#auth').style.display = 'none';
      $('#app').hidden = true;
      $('#app').style.display = 'none';
      await showAdminShell();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    hideAdminSecondFactor();
    hideAdminShell();
    model = mergeSnapshot(await api('/api/snapshot'));
    $('#auth').hidden = true;
    $('#auth').style.display = 'none';
    $('#app').hidden = false;
    $('#app').style.display = 'block';
    ensureAdminUi();
    switchView('dashboard');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    try {
      render();
    } catch (renderError) {
      console.error('Dashboard render error:', renderError);
      $('#dashboard').innerHTML = `<article class="panel"><h2>대시보드를 불러오는 중 문제가 발생했습니다.</h2><p class="error">${esc(renderError.message || '화면을 표시할 수 없습니다.')}</p><button type="button" onclick="location.reload()">다시 불러오기</button></article>`;
    }
    connect();
    loadWeather($('#weatherCitySelect')?.value || 'seoul');
  } catch (err) {
    console.error('Enter error:', err);
    localStorage.removeItem('wardrobeToken');
    clearAdminSession();
    token = null;
    showAuth();
    const authError = $('#authError');
    if (authError) authError.textContent = `로그인 후 내 옷장 데이터를 불러오지 못했습니다: ${err.message || '잠시 후 다시 시도해 주세요.'}`;
  }
}

async function showAuth() {
  hideAdminShell();
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

// ----------------- Form Submission & Event Listeners -----------------
// Keep the authentication form safe even if browser defaults are applied
// before the submit handler runs. The handler below still calls
// preventDefault() and sends credentials via POST to the API.
const authFormElement = $('#authForm');
if (authFormElement) {
  authFormElement.method = 'post';
  authFormElement.action = '/';
  const authSubmitElement = $('#authSubmit');
  if (authSubmitElement) authSubmitElement.type = 'submit';
}

function clearAdminSession() {
  adminSession = '';
  sessionStorage.removeItem('wardrobeAdminSession');
  if (sessionUser) sessionUser.adminVerified = false;
}

function hideAdminSecondFactor() {
  $('#adminSecondFactor')?.remove();
  const form = $('#authForm');
  if (form) form.style.display = '';
}

function showAdminSecondFactor() {
  const form = $('#authForm');
  if (form) form.style.display = 'none';
  let gate = $('#adminSecondFactor');
  if (!gate) {
    gate = document.createElement('form');
    gate.id = 'adminSecondFactor';
    gate.className = 'panel';
    gate.method = 'post';
    gate.action = '/';
    gate.innerHTML = '<p class="eyebrow">ADMIN SECURITY</p><h1>관리자 인증</h1><p class="muted">관리자 전용 2차 비밀번호를 입력하세요.</p><input id="adminSecondaryPassword" type="password" autocomplete="current-password" placeholder="2차 비밀번호" required><button type="submit">확인</button><p id="adminSecondaryError" class="error"></p><button type="button" id="adminSecondaryCancel" class="ghost">로그아웃</button>';
    $('#auth')?.append(gate);
  }
  gate.onsubmit = async event => {
    event.preventDefault();
    const password = $('#adminSecondaryPassword')?.value || '';
    const message = $('#adminSecondaryError');
    if (message) message.textContent = '';
    try {
      const verified = await api('/api/admin/verify', { method: 'POST', body: JSON.stringify({ password }) });
      adminSession = verified.adminSession;
      sessionStorage.setItem('wardrobeAdminSession', adminSession);
      if (sessionUser) sessionUser.adminVerified = true;
      await enter();
    } catch (error) {
      if (message) message.textContent = error.message || '관리자 인증에 실패했습니다.';
    }
  };
  $('#adminSecondaryCancel').onclick = () => $('#logout').click();
  $('#auth').hidden = false;
  $('#auth').style.display = 'grid';
  $('#app').hidden = true;
  $('#app').style.display = 'none';
  setTimeout(() => $('#adminSecondaryPassword')?.focus(), 0);
}

let adminOverviewData = null,
  adminView = 'dashboard',
  adminSelectedUserId = '',
  adminSelectedGatewayId = '',
  adminHighlightHangerId = '',
  adminUserQuery = '',
  adminDeviceQuery = '',
  adminDeviceMode = 'all',
  adminShowEvents = false;

const adminActive = () => sessionUser?.role === 'admin' && !!sessionUser.adminVerified;
const adminDate = value => value ? new Date(value).toLocaleString() : '-';
const adminState = value => String(value || 'OFFLINE') === 'ONLINE' ? '<span class="admin-online">● ONLINE</span>' : '<span class="admin-offline">● OFFLINE</span>';

function hideAdminShell() {
  $('#adminApp')?.remove();
  adminOverviewData = null;
  adminView = 'dashboard';
  adminSelectedUserId = '';
  adminSelectedGatewayId = '';
  adminHighlightHangerId = '';
  adminShowEvents = false;
}

function ensureAdminUi() {
  // The former admin tab belongs to the normal user shell. Administrators use
  // a separate shell so no wardrobe, outfit, NFC or device-control UI leaks in.
  $('#admin')?.remove();
  $('nav button[data-view="admin"]')?.remove();
}

async function showAdminShell() {
  ensureAdminUi();
  clearTimeout(retry);
  socket?.close();
  socket = null;
  let shell = $('#adminApp');
  if (!shell) {
    shell = document.createElement('div');
    shell.id = 'adminApp';
    shell.className = 'admin-shell';
    shell.innerHTML = `<header class="admin-header"><div><p class="eyebrow">SMART WARDROBE · ADMIN</p><h1>운영 관리자</h1><small>${esc(sessionUser?.name || '관리자')} · ${esc(sessionUser?.email || '')}</small></div><button id="adminLogout" class="ghost">로그아웃</button></header><nav class="admin-nav"><button data-admin-view="dashboard">운영 대시보드</button><button data-admin-view="users">사용자 관리</button><button data-admin-view="system">시스템 상태</button></nav><main id="adminContent" class="admin-content"><article class="panel"><p class="muted">관리자 현황을 불러오는 중입니다.</p></article></main>`;
    document.body.append(shell);
    $('#adminLogout').onclick = () => $('#logout').click();
  }
  await refreshAdminData();
}

async function refreshAdminData() {
  if (!adminActive()) return;
  const target = $('#adminContent');
  try {
    adminOverviewData = await api('/api/admin/overview');
    renderAdminShellView();
  } catch (error) {
    if (target) target.innerHTML = `<article class="panel"><h2>관리자 현황을 불러오지 못했습니다.</h2><p class="error">${esc(error.message)}</p><button type="button" id="adminRetry">다시 시도</button></article>`;
    $('#adminRetry')?.addEventListener('click', refreshAdminData);
  }
}

function adminSummaryCard(label, value, view, mode = '') {
  const display = (typeof value === 'number' || /^\d+$/.test(String(value ?? '')))
    ? Number(value || 0)
    : String(value || '-');
  return `<button type="button" class="admin-summary-card" data-admin-summary="${esc(view)}" data-admin-mode="${esc(mode)}"><b>${esc(display)}</b><span>${esc(label)}</span></button>`;
}

function adminHealth(level, label) {
  return `<span class="admin-health ${esc(level)}">${esc(label)}</span>`;
}

function adminHangerTree(hanger) {
  const garment = hanger.garmentName || (hanger.tagDetected ? '미등록 태그 감지' : '걸린 옷 없음');
  const level = hanger.state === 'ONLINE' && hanger.nfcStatus === '정상' ? 'normal' : hanger.state === 'ONLINE' ? 'warning' : 'problem';
  return `<article class="admin-tree-hanger${hanger.problem ? ' admin-problem-card' : ''}${adminHighlightHangerId === hanger.hangerId ? ' admin-highlight' : ''}"><div><b>${esc(hanger.name || `${hanger.hangerNumber}번 옷걸이`)}</b>${adminHealth(level, hanger.state === 'ONLINE' ? hanger.nfcStatus === '정상' ? '정상' : '주의' : '장애')}</div><small>${esc(hanger.hangerId)} · ${esc(hanger.hangerNumber || '-')}번 · 현재 옷봉 ${esc(hanger.gatewayId || '없음')} · 채널 ${esc(hanger.channel ?? '알 수 없음')}</small><dl><dt>통신</dt><dd>${adminState(hanger.state)} · 마지막 ${esc(adminDate(hanger.lastSeen))}</dd><dt>PN532/NFC</dt><dd>${esc(hanger.nfcStatus || '알 수 없음')}</dd><dt>현재 상태</dt><dd>${esc(hanger.reportedState || '알 수 없음')}</dd><dt>현재 옷</dt><dd>${esc(garment)}</dd></dl>${hanger.problemReasons?.length ? `<p class="admin-problem-text">${esc(hanger.problemReasons.join(' · '))}</p>` : ''}</article>`;
}

function adminGatewayTree(gateway) {
  const level = gateway.problem ? 'problem' : gateway.state === 'ONLINE' ? 'normal' : 'problem';
  const wifi = gateway.wifiStatus === 'CONNECTED' ? `연결됨${gateway.ssid ? ` (${gateway.ssid})` : ''}` : gateway.wifiStatus === 'FAILED' ? '실패' : '상태 확인 불가';
  const cloud = gateway.cloudStatus === 'CONNECTED' ? '최근 Cloud heartbeat 수신' : gateway.cloudStatus === 'FAILED' ? '실패' : '상태 확인 불가';
  return `<article class="admin-tree-gateway${gateway.problem ? ' admin-problem-card' : ''}"><header><div><b>${esc(gateway.name || `${gateway.gatewayNumber}번 옷봉`)}</b><small>${esc(gateway.gatewayId)} · ${esc(gateway.gatewayNumber || '-')}번</small></div>${adminHealth(level, gateway.problem ? '문제' : '정상')}</header><dl class="admin-gateway-meta"><dt>통신</dt><dd>${adminState(gateway.state)} · 마지막 heartbeat ${esc(adminDate(gateway.lastSeen))}</dd><dt>Wi-Fi</dt><dd>${esc(wifi)} · RSSI ${esc(gateway.rssi ?? '알 수 없음')}</dd><dt>Cloud</dt><dd>${esc(cloud)}</dd><dt>연결 옷걸이</dt><dd>${Number(gateway.hangerCount || 0)}개</dd></dl>${gateway.provisioningStatus === 'TIMEOUT' ? `<p class="admin-problem-text">설정 후 heartbeat 확인 시간초과 · Wi-Fi/Cloud 원인은 현재 알 수 없음</p>` : ''}<div class="admin-tree-hangers">${(gateway.hangers || []).map(adminHangerTree).join('') || '<p class="muted">연결된 옷걸이가 없습니다.</p>'}</div></article>`;
}

function adminUserCard(user) {
  const expanded = adminSelectedUserId === user.id;
  return `<button type="button" class="admin-user-card${expanded ? ' expanded' : ''}${Number(user.problemDeviceCount || 0) ? ' admin-problem-card' : ''}" data-admin-user="${esc(user.id)}"><b>${esc(user.name)}</b><span>${esc(user.email)}</span><small>최근 로그인 ${esc(adminDate(user.lastLoginAt))}</small><small>옷봉 ${Number(user.gatewayCount || 0)} · 옷걸이 ${Number(user.hangerCount || 0)} · 미연결 ${Number(user.unassignedHangerCount || 0)} · 옷 ${Number(user.garmentCount || 0)}</small><small class="${Number(user.problemDeviceCount || 0) ? 'admin-problem-text' : 'muted'}">${Number(user.problemDeviceCount || 0) ? `문제 장비 ${Number(user.problemDeviceCount || 0)}건` : '문제 장비 없음'}</small></button>`;
}

function renderAdminDashboard(data) {
  const t = data.totals || {};
  const system = data.system || {}, problems = data.problems || [];
  return `<section><div class="title"><div><h2>운영 대시보드</h2><p>문제 장비를 먼저 확인하고, 필요하면 사용자와 장비 계층으로 추적합니다.</p></div><button type="button" id="adminRefresh">새로고침</button></div><div class="admin-health-grid">${[
    ['normal', 'Backend', system.backend?.ready ? '정상' : '장애'], ['normal', 'PostgreSQL', system.backend?.storage === 'postgres' ? '정상' : '알 수 없음'],
    [system.imageProcessing?.configured ? 'normal' : 'warning', 'Image Worker', system.imageProcessing?.configured ? '설정됨' : '미설정'],
    [t.offlineGateways ? 'problem' : 'normal', 'Offline Gateway', `${Number(t.offlineGateways || 0)}대`],
    [t.offlineHangers ? 'problem' : 'normal', 'Offline Hanger', `${Number(t.offlineHangers || 0)}대`],
    [t.provisioningTimeouts ? 'warning' : 'normal', 'Wi-Fi/Cloud 확인 시간초과', `${Number(t.provisioningTimeouts || 0)}건`],
  ].map(([level, label, value]) => `<article class="admin-health-card ${esc(level)}">${adminHealth(level, value)}<b>${esc(label)}</b></article>`).join('')}</div><section class="admin-problems"><div class="title"><div><h3>장애·주의 ${problems.length}건</h3><p>${problems.length ? '항목을 선택하면 대상 사용자 장비 구조를 바로 엽니다.' : '현재 감지된 주요 장애가 없습니다.'}</p></div></div>${problems.slice(0, 12).map(problem => `<button type="button" class="admin-problem" data-admin-problem-user="${esc(problem.userId || '')}" data-admin-problem-gateway="${esc(problem.gatewayId || '')}" data-admin-problem-hanger="${esc(problem.hangerId || '')}">${adminHealth(problem.level, problem.level === 'problem' ? '문제' : '주의')}<span><b>${esc(problem.title)}</b><small>${esc(problem.userName || '시스템')} · ${esc(problem.message)}</small></span></button>`).join('')}</section><div class="admin-summary-grid admin-small-summary">${[
    adminSummaryCard('사용자', t.users, 'users'), adminSummaryCard('옷봉', t.gateways, 'users'), adminSummaryCard('옷걸이', t.hangers, 'users'), adminSummaryCard('옷', t.garments, 'users')
  ].join('')}</div></section>`;
}

function renderAdminUsers(data) {
  const query = adminUserQuery.trim().toLowerCase();
  const users = (data.users || []).filter(user => user.role === 'user' && (!query || `${user.name} ${user.email}`.toLowerCase().includes(query)));
  return `<section><div class="title"><div><h2>사용자 관리</h2><p>사용자를 클릭하면 같은 화면에서 옷봉 → 옷걸이 전체 구조가 펼쳐집니다.</p></div><button type="button" id="adminRefresh">새로고침</button></div><input id="adminUserSearch" class="admin-search" value="${esc(adminUserQuery)}" placeholder="이름 또는 이메일 검색"><div class="admin-list">${users.map(user => `${adminUserCard(user)}${adminSelectedUserId === user.id ? `<div class="admin-user-expanded">${renderAdminUserDetail(data)}</div>` : ''}`).join('') || '<p class="muted">조건에 맞는 사용자가 없습니다.</p>'}</div></section>`;
}

function renderAdminUserDetail(data) {
  const user = (data.users || []).find(item => item.id === adminSelectedUserId);
  if (!user) return renderAdminUsers(data);
  const canDelete = user.id !== sessionUser?.id;
  return `<section class="admin-user-detail"><div class="title"><div><h2>${esc(user.name)}</h2><p>${esc(user.email)} · 가입일 ${esc(adminDate(user.createdAt))} · 최근 로그인 ${esc(adminDate(user.lastLoginAt))}</p></div>${canDelete ? '<button type="button" class="danger" id="adminDeleteUser">사용자 삭제</button>' : '<small class="muted">현재 로그인한 관리자 계정은 삭제할 수 없습니다.</small>'}</div><div class="admin-count-line">옷봉 ${Number(user.gatewayCount || 0)}개 · 옷걸이 ${Number(user.hangerCount || 0)}개 · 연결됨 ${Number(user.connectedHangerCount || 0)}개 · 미연결 ${Number(user.unassignedHangerCount || 0)}개 · 옷 ${Number(user.garmentCount || 0)}개 · ${Number(user.problemDeviceCount || 0) ? `⚠ 문제 장비 ${Number(user.problemDeviceCount || 0)}건` : '문제 장비 없음'}</div><div class="admin-tree">${(user.gateways || []).map(adminGatewayTree).join('') || '<p class="muted">등록된 옷봉이 없습니다.</p>'}</div><section class="admin-unassigned"><h3>옷봉에 연결되지 않은 옷걸이 ${Number(user.unassignedHangerCount || 0)}개</h3>${(user.unassignedHangers || []).length ? `<div class="admin-tree-hangers">${(user.unassignedHangers || []).map(adminHangerTree).join('')}</div>` : '<p class="muted">모든 옷걸이가 옷봉에 연결되어 있습니다.</p>'}</section></section>`;
}

function renderAdminGatewayDetail(data) {
  const user = (data.users || []).find(item => item.id === adminSelectedUserId);
  const gateway = user?.gateways?.find(item => item.gatewayId === adminSelectedGatewayId);
  if (!gateway) return renderAdminUserDetail(data);
  return `<section><div class="title"><div><button type="button" class="ghost" id="adminBackUser">← ${esc(user.name)} 상세</button><h2>${esc(gateway.name || `${gateway.gatewayNumber}번 옷봉`)}</h2><p>소유 사용자 ${esc(user.name)}</p></div></div><div class="admin-tree">${adminGatewayTree(gateway)}</div></section>`;
}

function renderAdminDevices(data) {
  const query = adminDeviceQuery.trim().toLowerCase(), mode = adminDeviceMode;
  const rows = (data.users || []).flatMap(user => (user.gateways || []).flatMap(gateway => [{kind:'gateway', user, gateway}, ...(gateway.hangers || []).map(hanger => ({kind:'hanger', user, gateway, hanger}))]));
  const filtered = rows.filter(row => {
    const item = row.hanger || row.gateway, text = `${row.user.name} ${row.user.email} ${item.name} ${item.gatewayId || item.hangerId}`.toLowerCase();
    if (query && !text.includes(query)) return false;
    if (mode.startsWith('gateway') && row.kind !== 'gateway') return false;
    if (mode.startsWith('hanger') && row.kind !== 'hanger') return false;
    if (mode.endsWith('online') && item.state !== 'ONLINE') return false;
    if (mode.endsWith('offline') && item.state === 'ONLINE') return false;
    return true;
  });
  return `<section><div class="title"><div><h2>장비 관리</h2><p>사용자 또는 하드웨어 ID로 검색한 뒤 해당 사용자 장비 구조를 엽니다.</p></div><button type="button" id="adminRefresh">새로고침</button></div><input id="adminDeviceSearch" class="admin-search" value="${esc(adminDeviceQuery)}" placeholder="사용자, 이메일, 장비 이름 또는 하드웨어 ID 검색"><div class="admin-device-tabs"><button data-admin-device-mode="all">전체</button><button data-admin-device-mode="gateway">옷봉</button><button data-admin-device-mode="hanger">옷걸이</button></div><div class="admin-list">${filtered.map(row => { const item=row.hanger||row.gateway; return `<button type="button" class="admin-device-card" data-admin-user="${esc(row.user.id)}" data-admin-gateway="${esc(row.gateway.gatewayId)}"><b>${row.kind==='gateway'?'옷봉':'옷걸이'} · ${esc(item.name || item.gatewayId || item.hangerId)}</b>${adminState(item.state)}<small>소유 사용자: ${esc(row.user.name)} (${esc(row.user.email)})</small><small>${esc(item.gatewayId || item.hangerId)} · 번호 ${Number(item.gatewayNumber || item.hangerNumber || 0) || '-'} · ${row.kind==='gateway'?`옷걸이 ${Number(item.hangerCount || 0)}개`:`현재 옷봉 ${esc(row.gateway.name || row.gateway.gatewayId)}`}</small></button>`; }).join('') || '<p class="muted">조건에 맞는 장비가 없습니다.</p>'}</div></section>`;
}

function renderAdminSystem(data) {
  const system = data.system || {}, image = system.imageProcessing || {}, backend = system.backend || {};
  const gateway = system.gateways || {}, hanger = system.hangers || {}, ws = system.websocket || {}, storage = system.storage || {};
  const adminOwned = system.ownershipRecovery?.adminOwnedGateways || [];
  const recovery = adminOwned.length ? `<section class="admin-recovery"><h3>소유권 복구 필요</h3><p>관리자 계정에 귀속된 장비는 일반 사용자 목록에서 숨겨져 있습니다. 실제 사용자가 다시 연결할 수 있도록 등록 해제하세요.</p>${adminOwned.map(item => `<article><b>${esc(item.name)}</b><small>${esc(item.gatewayId)} · 연결 옷걸이 ${Number(item.hangerIds?.length || 0)}개</small><button type="button" class="danger" data-admin-release-gateway="${esc(item.gatewayId)}">관리자 소유권 등록 해제</button></article>`).join('')}</section>` : '';
  return `<section><div class="title"><div><h2>시스템 상태</h2><p>상태 근거가 없는 항목은 정상으로 추측하지 않고 ‘알 수 없음’으로 표시합니다.</p></div><button type="button" id="adminRefresh">새로고침</button></div><div class="admin-system-grid"><article class="panel"><h3>SERVER</h3><p>Backend ${adminHealth(backend.ready ? 'normal' : 'problem', backend.ready ? '정상' : '장애')}</p><p>PostgreSQL ${adminHealth(backend.storage === 'postgres' ? 'normal' : 'warning', backend.storage === 'postgres' ? '정상' : '알 수 없음')}</p><p>WebSocket ${adminHealth(ws.status === 'CONNECTED' ? 'normal' : 'warning', ws.status === 'CONNECTED' ? '연결 있음' : '알 수 없음')}</p><p>Supabase Storage ${adminHealth(storage.status === 'CONFIGURED' ? 'normal' : 'warning', storage.status === 'CONFIGURED' ? '설정됨' : '알 수 없음')}</p></article><article class="panel"><h3>GATEWAY</h3><p>전체 ${Number(gateway.total || 0)} · ONLINE ${Number(gateway.online || 0)} · OFFLINE ${Number(gateway.offline || 0)}</p><p>Wi-Fi 실패 ${Number(gateway.wifiFailures || 0)} · Cloud 실패 ${Number(gateway.cloudFailures || 0)}</p><p>설정 후 heartbeat 확인 시간초과 ${Number(gateway.provisioningTimeouts || 0)}건</p></article><article class="panel"><h3>HANGER</h3><p>전체 ${Number(hanger.total || 0)} · ONLINE ${Number(hanger.online || 0)} · OFFLINE ${Number(hanger.offline || 0)}</p><p>PN532 정상 ${Number(hanger.nfcReady || 0)} · 점검 필요 ${Number(hanger.nfcAttention || 0)}</p></article><article class="panel"><h3>PHOTO</h3><p>Image Worker ${adminHealth(image.configured ? 'normal' : 'warning', image.configured ? '설정됨' : '미설정')}</p><p>처리 중 ${Number(image.processing || 0)} · 완료 ${Number(image.ready || 0)} · 실패 ${Number(image.failed || 0)}</p></article></div>${recovery}<section class="admin-events"><div class="title"><h3>최근 이벤트</h3><button type="button" id="adminToggleEvents">${adminShowEvents ? '접기' : '최근 이벤트 보기'}</button></div>${adminShowEvents ? `<ol class="events">${(system.recentDeviceEvents || []).map(event => `<li>${esc(event.at ? new Date(event.at).toLocaleString() : '-')} · ${esc(event.type)} · ${esc(event.deviceId || '-')} ${esc(event.state || '')}</li>`).join('') || '<li>최근 장비 이벤트 없음</li>'}</ol>` : ''}</section></section>`;
}

function renderAdminShellView() {
  if (!adminActive()) return;
  const content = $('#adminContent'), data = adminOverviewData;
  if (!content || !data) return;
  const view = adminView === 'user-detail' ? renderAdminUserDetail(data) : adminView === 'gateway-detail' ? renderAdminGatewayDetail(data) : adminView === 'users' ? renderAdminUsers(data) : adminView === 'system' ? renderAdminSystem(data) : renderAdminDashboard(data);
  content.innerHTML = view;
  $$('#adminApp [data-admin-view]').forEach(button => { button.classList.toggle('active', button.dataset.adminView === adminView); button.onclick = () => { adminView = button.dataset.adminView; renderAdminShellView(); }; });
  $$('#adminApp [data-admin-summary]').forEach(button => button.onclick = () => { adminView = button.dataset.adminSummary; adminDeviceMode = button.dataset.adminMode || 'all'; renderAdminShellView(); });
  $$('#adminApp [data-admin-problem-user]').forEach(button => button.onclick = () => { const userId = button.dataset.adminProblemUser; if (!userId) { adminView = 'system'; renderAdminShellView(); return; } adminSelectedUserId = userId; adminHighlightHangerId = button.dataset.adminProblemHanger || ''; adminView = 'users'; renderAdminShellView(); });
  $('#adminRefresh')?.addEventListener('click', refreshAdminData);
  $('#adminUserSearch')?.addEventListener('input', event => { adminUserQuery = event.target.value; renderAdminShellView(); });
  $$('#adminApp [data-admin-user]').forEach(button => button.onclick = () => { const next = button.dataset.adminUser; adminHighlightHangerId = ''; adminSelectedUserId = adminSelectedUserId === next ? '' : next; adminView = 'users'; renderAdminShellView(); });
  $$('#adminApp [data-admin-gateway]').forEach(button => button.onclick = () => { adminSelectedGatewayId = button.dataset.adminGateway; adminView = 'gateway-detail'; renderAdminShellView(); });
  $('#adminBackUser')?.addEventListener('click', () => { adminView = 'user-detail'; renderAdminShellView(); });
  $('#adminDeviceSearch')?.addEventListener('input', event => { adminDeviceQuery = event.target.value; renderAdminShellView(); });
  $$('#adminApp [data-admin-device-mode]').forEach(button => button.onclick = () => { adminDeviceMode = button.dataset.adminDeviceMode; renderAdminShellView(); });
  $('#adminToggleEvents')?.addEventListener('click', () => { adminShowEvents = !adminShowEvents; renderAdminShellView(); });
  $$('#adminApp [data-admin-release-gateway]').forEach(button => button.onclick = async () => {
    const gatewayId = button.dataset.adminReleaseGateway;
    if (!gatewayId || !window.confirm(`${gatewayId}와 연결된 미등록 옷걸이를 관리자 계정에서 등록 해제할까요? 실제 사용자가 다시 연결할 수 있게 됩니다.`)) return;
    try { await api(`/api/admin/gateways/${encodeURIComponent(gatewayId)}/release`, { method: 'POST' }); await refreshAdminData(); }
    catch (error) { alert(error.message); }
  });
  $('#adminDeleteUser')?.addEventListener('click', async () => {
    const target = (data.users || []).find(user => user.id === adminSelectedUserId);
    if (!target || target.id === sessionUser?.id) return;
    if (!window.confirm(`정말로 ${target.name} 계정을 삭제할까요? 해당 사용자의 옷 정보는 삭제되고, 실물 옷봉·옷걸이는 등록 해제됩니다.`)) return;
    try { await api(`/api/admin/users/${encodeURIComponent(target.id)}`, { method: 'DELETE' }); adminSelectedUserId = ''; adminHighlightHangerId = ''; await refreshAdminData(); }
    catch (error) { alert(error.message); }
  });
}

const adminStyle = document.createElement('style');
adminStyle.textContent = '.admin-shell{min-height:100vh;background:#f7f7f2;color:var(--ink)}.admin-header{display:flex;justify-content:space-between;align-items:center;padding:28px max(28px,calc((100vw - 1240px)/2));background:#19352b;color:#fff}.admin-header h1{margin:0}.admin-header .ghost{color:#fff;border-color:#98b5a4}.admin-nav{display:flex;gap:8px;padding:12px max(28px,calc((100vw - 1240px)/2));background:#fff;border-bottom:1px solid #dae3dc;flex-wrap:wrap}.admin-nav button{background:transparent;color:var(--ink)}.admin-nav button.active{background:#dce9df}.admin-content{max-width:1240px;margin:0 auto;padding:28px}.admin-summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.admin-summary-card{display:flex;flex-direction:column;text-align:left;gap:5px;background:#fff;color:var(--ink);border:1px solid #dce5de;box-shadow:0 5px 16px #19352b12}.admin-summary-card b{font-size:26px}.admin-list{display:grid;gap:10px;margin-top:16px}.admin-user-card,.admin-gateway-card,.admin-device-card{display:grid;gap:5px;text-align:left;background:#fff;color:var(--ink);border:1px solid #dce5de}.admin-user-card small,.admin-gateway-card small,.admin-device-card small,.admin-hanger-card small{color:#66766c}.admin-hanger-card{display:grid;grid-template-columns:minmax(200px,1fr) minmax(240px,1fr);gap:16px;padding:16px;background:#fff;border:1px solid #dce5de;border-radius:12px}.admin-hanger-card dl{display:grid;grid-template-columns:100px 1fr;gap:5px;margin:0}.admin-hanger-card dt{color:#66766c}.admin-hanger-card dd{margin:0}.admin-search{max-width:520px}.admin-device-tabs{display:flex;gap:8px;margin-top:10px}.admin-device-tabs button{background:#eef5ef;color:var(--ink)}.admin-online{color:#218451}.admin-offline{color:#b3463f}.admin-count-line{padding:12px 0;font-weight:600}@media(max-width:620px){.admin-header{padding:20px}.admin-content{padding:18px}.admin-hanger-card{grid-template-columns:1fr}}';
document.head.append(adminStyle);

const adminOperationalStyle = document.createElement('style');
adminOperationalStyle.textContent = '.admin-health-grid,.admin-system-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.admin-health-card{display:grid;gap:8px;padding:16px;border:1px solid #dce5de;border-radius:12px;background:#fff}.admin-health-card b{font-size:16px}.admin-health{display:inline-flex;width:max-content;border-radius:999px;padding:3px 9px;font-size:12px;font-weight:700}.admin-health.normal{background:#def3e5;color:#16643d}.admin-health.warning{background:#fff3cd;color:#855b00}.admin-health.problem{background:#fde5e2;color:#a62d26}.admin-problems{margin:22px 0;padding:18px;border:1px solid #e0e6df;border-radius:14px;background:#fff}.admin-problem{width:100%;display:flex;align-items:flex-start;gap:10px;margin-top:8px;text-align:left;background:#f8faf7;color:var(--ink);border:1px solid #e0e6df}.admin-problem small{display:block;margin-top:4px;color:#66766c}.admin-small-summary{margin-top:18px}.admin-tree{display:grid;gap:14px;margin-top:16px}.admin-tree-gateway{padding:16px;border:1px solid #d6e1d8;border-left:5px solid #4b8260;border-radius:12px;background:#fff}.admin-tree-gateway>header{display:flex;justify-content:space-between;gap:12px;align-items:start}.admin-tree-gateway header small{display:block;color:#66766c;margin-top:3px}.admin-gateway-meta{display:grid;grid-template-columns:130px 1fr;gap:6px 12px;margin:14px 0}.admin-gateway-meta dt,.admin-tree-hanger dt{color:#66766c}.admin-gateway-meta dd,.admin-tree-hanger dd{margin:0}.admin-tree-hangers{display:grid;gap:9px;margin-left:18px;padding-left:16px;border-left:2px solid #d6e1d8}.admin-tree-hanger{padding:12px;border:1px solid #e2e9e3;border-radius:10px;background:#fbfcfa}.admin-tree-hanger>div{display:flex;gap:8px;align-items:center}.admin-tree-hanger small{display:block;margin:5px 0;color:#66766c}.admin-tree-hanger dl{display:grid;grid-template-columns:92px 1fr;gap:4px 10px;margin:0}.admin-system-grid{margin-bottom:16px}.admin-system-grid .panel{margin:0}.admin-system-grid p{display:flex;justify-content:space-between;align-items:center;gap:8px}.admin-events{padding:16px;border:1px solid #dce5de;border-radius:12px;background:#fff}.admin-events .title{margin-bottom:0}@media(max-width:620px){.admin-gateway-meta,.admin-tree-hanger dl{grid-template-columns:1fr}.admin-tree-hangers{margin-left:4px;padding-left:9px}.admin-tree-gateway>header{display:grid}}';
document.head.append(adminOperationalStyle);

const adminUserHierarchyStyle = document.createElement('style');
adminUserHierarchyStyle.textContent = '.admin-user-card.expanded{border-color:#4b8260;background:#f2f8f2}.admin-problem-card{border-color:#d86b64!important;background:#fff3f1!important}.admin-user-card.admin-problem-card.expanded{border-color:#c8534c!important;background:#fff1ee!important}.admin-user-expanded{margin:-2px 0 12px;padding:18px;border:1px solid #d6e1d8;border-radius:12px;background:#fff}.admin-user-expanded .admin-user-detail>.title{align-items:flex-start}.admin-unassigned{margin-top:18px;padding:16px;border:1px dashed #bdcdbf;border-radius:12px;background:#fafcf9}.admin-unassigned h3{margin-top:0}.admin-highlight{outline:3px solid #d99b27;outline-offset:2px;background:#fff9e8}.admin-problem-text{color:#a62d26;font-weight:700;margin:10px 0 0}.danger{background:#b33d36;color:#fff;border-color:#b33d36}@media(max-width:620px){.admin-user-expanded{padding:12px}.admin-user-expanded .admin-user-detail>.title{display:grid;gap:10px}}';
document.head.append(adminUserHierarchyStyle);

$('#authToggle').onclick = () => setAuthMode(currentAuthMode === 'login' ? 'signup' : 'login', false);

$('#authForm').onsubmit = async e => {
  e.preventDefault();
  removeCredentialQuery();
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
    history.replaceState(null, '', `${location.pathname}${location.hash}`);

    if (successBox) {
      successBox.textContent = mode === 'signup' ? '✓ 회원가입 완료' : '✓ 로그인 완료';
      successBox.style.display = 'block';
    }

    // Do not force a reload here. A free cloud instance can be waking up just
    // as the login finishes, and an unconditional reload hid that failure on
    // the login page. Enter now and show an actionable error if snapshot
    // loading genuinely fails.
    await enter();
    submitBtn.disabled = false;
  } catch (x) {
    submitBtn.disabled = false;
    $('#authError').textContent = x.message;
  }
};

let garmentPhotoObjectUrl = '';
let garmentPhotoRequestId = 0;
let garmentPhotoFile = null;
let garmentPhotoMode = 'local';

function uploadGarmentPhoto(path, formData) {
  return fetch(path, {
    method: 'POST',
    headers: token ? { authorization: 'Bearer ' + token } : {},
    body: formData,
  }).then(async response => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(payload.error || `HTTP ${response.status}`);
    return payload;
  });
}

function resetGarmentPhoto() {
  garmentPhotoRequestId += 1;
  if (garmentPhotoObjectUrl) URL.revokeObjectURL(garmentPhotoObjectUrl);
  garmentPhotoObjectUrl = '';
  garmentPhotoFile = null;
  const imageInput = $('#garmentImageUrl');
  const fileInput = $('#garmentPhotoFile');
  const preview = $('#garmentPhotoPreview');
  const status = $('#garmentPhotoStatus');
  if (imageInput) imageInput.value = '';
  if (fileInput) fileInput.value = '';
  if (preview) { preview.hidden = true; preview.querySelector('img').removeAttribute('src'); }
  if (status) { status.className = 'garment-photo-status'; status.textContent = '사진을 선택하면 배경을 제거하고 옷 정보를 추천합니다.'; }
}

function applyGarmentClassification(result) {
  const predicted = result?.predictions || {};
  const category = predicted.category?.top || '';
  const color = predicted.color?.top || '';
  const season = predicted.season?.top || '';
  if (category) $('#garmentCategory').value = category;
  if (color) $('#garmentColor').value = color;
  if (season) $('#garmentSeason').value = season;
  const name = $('#garmentName');
  if (name && !name.value.trim() && (color || category)) name.value = [color, category].filter(Boolean).join(' ');
}

function setupGarmentPhotoField() {
  const form = $('#garmentForm');
  const urlInput = form?.querySelector('input[name="imageUrl"]');
  if (!form || !urlInput || $('#garmentPhotoField')) return;
  urlInput.id = 'garmentImageUrl';
  // Processed photos use a same-site path (/api/garments/images/...).
  // Keep that value in the submitted form, but do not apply the browser's
  // absolute-URL validation to this internal storage path.
  urlInput.type = 'hidden';
  const oldLabel = urlInput.closest('label');
  oldLabel.hidden = true;
  const field = document.createElement('section');
  field.id = 'garmentPhotoField';
  field.className = 'garment-photo-field';
  field.innerHTML = `<b>옷 사진 <small class="muted">선택 사항</small></b><div class="garment-photo-controls"><input id="garmentPhotoFile" type="file" accept="image/jpeg,image/png,image/webp" hidden><button type="button" id="garmentPhotoChoose" class="photo-secondary">사진 선택</button><span id="garmentPhotoStatus" class="garment-photo-status">사진을 선택하면 배경을 제거하고 옷 정보를 추천합니다.</span></div><div id="garmentPhotoPreview" class="garment-photo-preview" hidden><img alt="배경이 제거된 옷 사진"><button type="button" id="garmentPhotoClear" class="photo-secondary">사진 제거</button></div><p id="garmentPhotoNote" class="muted garment-photo-note">사진 처리 환경을 확인하는 중입니다.</p>`;
  // Keep the photo immediately after the dialog title and before the garment name.
  const dialogTitle = form.querySelector(':scope > .title');
  if (dialogTitle) dialogTitle.after(field);
  else form.prepend(field);
  const fileInput = $('#garmentPhotoFile');
  api('/api/garments/image/status').then(info => {
    garmentPhotoMode = info.mode || 'local';
    const note = $('#garmentPhotoNote');
    if (note) note.textContent = garmentPhotoMode === 'cloud' ? '사진은 클라우드에서 비동기 처리됩니다. 등록 후에도 처리 중 상태를 확인할 수 있습니다.' : '사진은 이 PC의 로컬 AI로 처리됩니다. 자동 추천값은 언제든 수정할 수 있습니다.';
  }).catch(() => {});
  $('#garmentPhotoChoose').onclick = () => fileInput.click();
  $('#garmentPhotoClear').onclick = resetGarmentPhoto;
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size > 12 * 1024 * 1024) {
      $('#garmentPhotoStatus').textContent = 'JPG, PNG, WEBP 형식의 12MB 이하 사진을 선택해주세요.';
      $('#garmentPhotoStatus').className = 'garment-photo-status is-error';
      return;
    }
    if (garmentPhotoObjectUrl) URL.revokeObjectURL(garmentPhotoObjectUrl);
    garmentPhotoFile = file;
    garmentPhotoObjectUrl = URL.createObjectURL(file);
    const preview = $('#garmentPhotoPreview');
    preview.querySelector('img').src = garmentPhotoObjectUrl;
    preview.hidden = false;
    const status = $('#garmentPhotoStatus');
    if (garmentPhotoMode === 'cloud') {
      status.textContent = '등록하면 클라우드에 저장한 뒤 배경 제거를 시작합니다. 처리 중에도 다른 작업을 할 수 있습니다.';
      status.className = 'garment-photo-status is-working';
      return;
    }
    status.textContent = '배경 제거와 옷 정보 분석을 준비 중입니다. 처음 한 번은 모델 준비에 시간이 걸릴 수 있습니다.';
    status.className = 'garment-photo-status is-working';
    const buildData = () => { const data = new FormData(); data.append('image', file, file.name); return data; };
    const requestId = ++garmentPhotoRequestId;
    const imageRequest = uploadGarmentPhoto('/api/garments/image', buildData());
    const classifyRequest = uploadGarmentPhoto('/api/garments/classify', buildData());
    let imageReady = false;
    let classificationReady = false;
    imageRequest.then(result => {
      if (requestId !== garmentPhotoRequestId) return;
      imageReady = true;
      $('#garmentImageUrl').value = result.imageUrl;
      preview.querySelector('img').src = result.imageUrl;
      status.textContent = classificationReady
        ? '배경 제거 완료 · 종류, 색상, 계절 추천값을 입력했습니다.'
        : '배경 제거 완료 · 옷 정보를 분석 중입니다. 기다리지 않고 아래 정보를 직접 입력하거나 등록할 수 있습니다.';
      status.className = 'garment-photo-status is-ready';
    }).catch(error => {
      if (requestId !== garmentPhotoRequestId) return;
      status.textContent = error.message || '배경 제거에 실패했습니다. 다시 시도해주세요.';
      status.className = 'garment-photo-status is-error';
    });
    classifyRequest.then(result => {
      if (requestId !== garmentPhotoRequestId) return;
      classificationReady = true;
      applyGarmentClassification(result);
      status.textContent = imageReady
        ? '배경 제거 완료 · 종류, 색상, 계절 추천값을 입력했습니다.'
        : '옷 정보 추천을 완료했습니다. 배경 제거 결과를 기다리는 중입니다.';
      status.className = 'garment-photo-status is-ready';
    }).catch(error => {
      if (requestId !== garmentPhotoRequestId || !imageReady) return;
      status.textContent = '배경 제거는 완료됐습니다. 옷 정보는 직접 입력해주세요.';
      status.className = 'garment-photo-status is-ready';
    });
  };
}

const garmentPhotoStyle = document.createElement('style');
garmentPhotoStyle.textContent = '.garment-photo-field{margin:14px 0;padding:13px;border:1px solid #d8e5dc;border-radius:12px;background:#f8fbf8}.garment-photo-controls{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-top:8px}.photo-secondary{padding:8px 11px;background:#eef7f0;color:var(--ink);border:1px solid #9fbcaa;font-size:13px}.garment-photo-status{font-size:12px;color:#708078}.garment-photo-status.is-working{color:var(--amber)}.garment-photo-status.is-ready{color:#218451}.garment-photo-status.is-error{color:var(--red)}.garment-photo-preview{display:flex;gap:12px;align-items:center;margin-top:12px;padding:9px;border:1px solid #d8e5dc;border-radius:10px;background:#fff}.garment-photo-preview img{width:88px;height:112px;object-fit:contain;border-radius:7px;background:#e8eee8}.garment-photo-note{font-size:11px;margin:9px 0 0}';
document.head.append(garmentPhotoStyle);
setupGarmentPhotoField();

$$('[data-open-garment]').forEach(x =>
  (x.onclick = () => {
    const formErr = $('#formError');
    const successBox = $('#garmentSuccess');
    if (formErr) formErr.textContent = '';
    if (successBox) successBox.style.display = 'none';
    const form = $('#garmentForm');
    if (form) form.reset();
    resetGarmentPhoto();
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
    const garment = await api('/api/garments', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    if (garmentPhotoMode === 'cloud' && garmentPhotoFile) {
      const upload = new FormData();
      upload.append('image', garmentPhotoFile, garmentPhotoFile.name);
      await uploadGarmentPhoto(`/api/garments/${encodeURIComponent(garment.id)}/image`, upload);
      const photoStatus = $('#garmentPhotoStatus');
      if (photoStatus) {
        photoStatus.textContent = '클라우드 사진 처리 중입니다. 완료되면 옷 사진이 자동으로 표시됩니다.';
        photoStatus.className = 'garment-photo-status is-working';
      }
    }

    if (successBox) {
      successBox.textContent = '✓ 옷 등록 완료';
      successBox.style.display = 'block';
    }

    setTimeout(() => {
      e.target.reset();
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
  hangerFreshness.clear();
  model = { garments: [], hangers: [], gateways: [], events: [], commands: [] };
  refreshGeneration++;
  localStorage.removeItem('wardrobeToken');
  clearAdminSession();
  hideAdminSecondFactor();
  hideAdminShell();
  token = null;
  sessionUser = null;
  removeCredentialQuery();
  showAuth();
};

function setBleSetupMessage(message, error = false) {
  const target = $('#bleSetupMessage');
  if (!target) return;
  target.textContent = message;
  target.className = error ? 'error' : 'muted';
}

function bleErrorMessage(error, action) {
  const detail = String(error?.message || '알 수 없는 블루투스 오류');
  if (/GATT operation failed|Unknown reason|NetworkError/i.test(detail)) {
    return `${action} 중 옷봉과의 블루투스 연결이 끊겼습니다. 옷봉 전원을 켠 채 PC 가까이에 두고, 옷봉 찾기부터 다시 해주세요.`;
  }
  if (/NotFoundError|cancel/i.test(detail)) return '블루투스 기기 선택이 취소되었습니다. 옷봉 찾기를 다시 눌러 주세요.';
  if (/NotSupported|secure context/i.test(detail)) return '이 기능은 Bluetooth가 켜진 PC Chrome에서 http://localhost:8787 로 열어야 합니다.';
  return `${action} 실패: ${detail}`;
}

function escapeWifiLabel(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

let currentBleGatewayId = '';
let currentGatewayOwnership = 'UNKNOWN';
let currentHangerOwnership = 'UNKNOWN';
let provisionPollInterval = null;
let rebootCountdownInterval = null;

function neutralBleLabel(kind, hardwareId) {
  const shortCode = String(hardwareId || '').toUpperCase().match(/([0-9A-F]{6})$/)?.[1] || '고유 코드';
  return `스마트 ${kind === 'gateways' ? '옷봉' : '옷걸이'} · ${shortCode}`;
}

async function refreshBleOwnership(kind, hardwareId, fallbackName = '') {
  if (!hardwareId) return { ownership: 'UNKNOWN', displayName: fallbackName || neutralBleLabel(kind, hardwareId) };
  const result = await api(`/api/${kind}/${encodeURIComponent(hardwareId)}/pairing-status`);
  if (kind === 'gateways') currentGatewayOwnership = result.ownership || 'UNKNOWN';
  else currentHangerOwnership = result.ownership || 'UNKNOWN';
  return result;
}

function pairingBlockedMessage(kind) {
  const device = kind === 'gateways' ? '옷봉' : '옷걸이';
  return `이 ${device}은 다른 계정에 등록되어 있습니다. 기존 계정에서 등록 해제 후 다시 연결해 주세요.`;
}

function timeAgo(dateString) {
  if (!dateString) return '신호 없음';
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(dateString)) / 1000));
  if (sec < 5) return '방금 전';
  if (sec < 60) return `${sec}초 전`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  return `${hr}시간 전`;
}

function formatRssi(rssi, online) {
  if (!online) return '-';
  const val = Number(rssi || 0);
  if (!val) return '보통';
  if (val >= -65) return `좋음 (${val} dBm)`;
  if (val >= -75) return `보통 (${val} dBm)`;
  return `약함 (${val} dBm)`;
}

function garmentNameForHanger(hanger) {
  if (!hanger || !hanger.tagUid) return '-';
  const g = (model.garments || []).find(item => item.tagUid === hanger.tagUid);
  return g ? g.name : `미등록 태그 (${hanger.tagUid.slice(0, 8)}…)`;
}

function linkedHangerCount(gatewayId) {
  if (!gatewayId) return 0;
  return (model.hangers || []).filter(h => h.gatewayId === gatewayId && !String(h.hangerId || '').startsWith('HC-000')).length;
}

function getPn532StatusHtml(h) {
  if (h.errorFlags === 0 || h.errorFlags === '0') {
    return '<span style="color:#218451;font-weight:600">● PN532 정상 (준비됨)</span>';
  }
  if (h.errorFlags === 1 || h.errorFlags === '1') {
    return '<span style="color:var(--red);font-weight:600">⚠️ PN532 점검 필요</span>';
  }
  return '<span style="color:#7b8b82">- 상태 확인 중</span>';
}

function renderNearbyWifiChoices() {
  const select = $('#nearbyWifiChoices');
  if (!select) return;
  const selected = select.value;
  select.innerHTML = '<option value="">2.4 GHz Wi-Fi를 선택하세요</option>' + nearbyWifiNetworks
    .map(network => `<option value="${escapeWifiLabel(network.ssid)}">${escapeWifiLabel(network.ssid)} · 신호 ${network.rssi} dBm · 채널 ${network.channel}</option>`)
    .join('');
  if (nearbyWifiNetworks.some(network => network.ssid === selected)) select.value = selected;
}

async function scanHangerWifi() {
  if (!bleConfigCharacteristic) return setBleSetupMessage('먼저 옷봉을 블루투스로 연결하세요.', true);
  nearbyWifiNetworks = [];
  renderNearbyWifiChoices();
  setBleSetupMessage('옷봉이 주변 2.4 GHz Wi-Fi를 검색 중입니다. 잠시 기다려 주세요.');
  try {
    const payload = new TextEncoder().encode(JSON.stringify({ action: 'scan' }));
    if (typeof bleConfigCharacteristic.writeValueWithResponse === 'function') await bleConfigCharacteristic.writeValueWithResponse(payload);
    else await bleConfigCharacteristic.writeValue(payload);
  } catch (error) {
    setBleSetupMessage(bleErrorMessage(error, 'Wi-Fi 검색 요청'), true);
  }
}

async function writeGatewayBle(action, extra = {}) {
  if (!bleConfigCharacteristic) return;
  const payload = new TextEncoder().encode(JSON.stringify({ action, ...extra }));
  if (typeof bleConfigCharacteristic.writeValueWithResponse === 'function') await bleConfigCharacteristic.writeValueWithResponse(payload);
  else await bleConfigCharacteristic.writeValue(payload);
}

async function handleGatewayBleStatus(value, fallbackName = '') {
  try {
    const text = new TextDecoder().decode(value);
    const info = JSON.parse(text);
    if (info.gatewayId) {
      currentBleGatewayId = info.gatewayId;
      const pairing = await refreshBleOwnership('gateways', currentBleGatewayId, fallbackName);
      const deviceLabel = $('#bleDeviceName');
      if (deviceLabel) deviceLabel.textContent = `${pairing.displayName || neutralBleLabel('gateways', currentBleGatewayId)} 연결됨`;
      if (pairing.ownership === 'OTHER_ACCOUNT') {
        const form = $('#bleWifiForm');
        if (form) form.hidden = true;
        setBleSetupMessage(pairingBlockedMessage('gateways'), true);
      }
    }
    if (info.state === 'network' && info.ssid) {
      if (!nearbyWifiNetworks.some(network => network.ssid === info.ssid)) {
        nearbyWifiNetworks.push(info);
        renderNearbyWifiChoices();
      }
      return;
    }
    setBleSetupMessage(info.message || '옷봉 상태를 받았습니다.', /error|failed|not_found/i.test(info.state || ''));
  } catch (_) {}
}

async function connectHangerBluetooth() {
  if (!navigator.bluetooth || !window.isSecureContext) {
    setBleSetupMessage('이 기능은 블루투스가 켜진 Chrome에서 HTTPS 또는 localhost로 열어야 합니다.', true);
    return;
  }
  const button = $('#connectHangerBle');
  if (button) {
    button.disabled = true;
    button.textContent = '옷봉 찾는 중… 잠시만 기다려 주세요';
  }
  try {
    setBleSetupMessage('브라우저 블루투스 선택창에서 “스마트 옷봉 · 고유 코드”를 선택하세요.');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE_UUID] }],
      optionalServices: [BLE_SERVICE_UUID],
    });
    const gatt = await device.gatt.connect();
    const service = await gatt.getPrimaryService(BLE_SERVICE_UUID);
    bleConfigCharacteristic = await service.getCharacteristic(BLE_CONFIG_UUID);
    const status = await service.getCharacteristic(BLE_STATUS_UUID);
    await status.startNotifications();

    status.addEventListener('characteristicvaluechanged', event => handleGatewayBleStatus(event.target.value, device.name || ''));

    const deviceLabel = $('#bleDeviceName');
    if (deviceLabel) deviceLabel.textContent = `${neutralBleLabel('gateways', currentBleGatewayId || device.name)} 연결됨`;
    const form = $('#bleWifiForm');
    if (form) form.hidden = false;

    // Notifications can be missed while Chrome finishes subscribing. Read the
    // current value first so provisioning always has the immutable gateway ID
    // needed to claim its first Cloud heartbeat.
    await handleGatewayBleStatus(await status.readValue(), device.name || '');
    await writeGatewayBle('status');
    await scanHangerWifi();
  } catch (error) {
    setBleSetupMessage(bleErrorMessage(error, '옷봉 연결'), true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '옷봉 찾기 (블루투스)';
    }
  }
}

function setStageItem(stageId, state, detailText) {
  const el = $(`#${stageId}`);
  if (!el) return;
  el.className = `stage-item ${state}`;
  const icon = el.querySelector('.stage-icon');
  if (icon) {
    if (state === 'active') icon.textContent = '⏳';
    else if (state === 'done') icon.textContent = '✅';
    else if (state === 'failed') icon.textContent = '❌';
    else icon.textContent = '⚪';
  }
  const detail = $('#progressStatusDetail');
  if (detail && detailText) detail.textContent = detailText;
}

function resetProvisionProgressUI() {
  clearInterval(provisionPollInterval);
  clearInterval(rebootCountdownInterval);
  const connectStep = $('#bleStepConnect');
  if (connectStep) connectStep.hidden = false;
  const progressStep = $('#bleStepProgress');
  if (progressStep) progressStep.hidden = true;
  const failActions = $('#progressFailureActions');
  if (failActions) failActions.hidden = true;
  const successActions = $('#progressSuccessActions');
  if (successActions) successActions.hidden = true;
  ['stage_save', 'stage_reboot', 'stage_wifi', 'stage_cloud', 'stage_claim'].forEach(s => setStageItem(s, 'pending'));
}

async function saveHangerWifi(event) {
  event.preventDefault();
  if (!bleConfigCharacteristic) return setBleSetupMessage('먼저 옷봉을 블루투스로 연결하세요.', true);
  const form = new FormData(event.currentTarget);
  const ssid = String(form.get('ssid') || '').trim();
  const password = String(form.get('password') || '');
  const server = String(form.get('server') || '').trim();
  if (!ssid || !server.startsWith('http')) return setBleSetupMessage('목록에서 2.4 GHz Wi-Fi를 선택하고 서버 주소를 확인하세요.', true);

  const connectStep = $('#bleStepConnect');
  if (connectStep) connectStep.hidden = true;
  const progressStep = $('#bleStepProgress');
  if (progressStep) progressStep.hidden = false;
  const progressTitle = $('#progressStageTitle');
  if (progressTitle) progressTitle.textContent = '연결 진행 중…';

  setStageItem('stage_save', 'active', '옷봉에 2.4 GHz Wi-Fi 정보를 전달하고 저장하는 중입니다...');

  try {
    const payload = new TextEncoder().encode(JSON.stringify({ ssid, password, server }));
    if (typeof bleConfigCharacteristic.writeValueWithResponse === 'function') {
      await bleConfigCharacteristic.writeValueWithResponse(payload);
    } else {
      await bleConfigCharacteristic.writeValue(payload);
    }

    setStageItem('stage_save', 'done', 'Wi-Fi 정보가 옷봉에 안전하게 저장되었습니다.');

    if (currentGatewayOwnership === 'OTHER_ACCOUNT') throw new Error(pairingBlockedMessage('gateways'));

    let remainingSeconds = 10;
    setStageItem('stage_reboot', 'active', `옷봉이 재시작 중입니다 (${remainingSeconds}초)...`);

    rebootCountdownInterval = setInterval(() => {
      remainingSeconds--;
      if (remainingSeconds > 0) {
        const timerEl = $('#rebootTimer');
        if (timerEl) timerEl.textContent = `(${remainingSeconds}초)`;
      } else {
        clearInterval(rebootCountdownInterval);
        const timerEl = $('#rebootTimer');
        if (timerEl) timerEl.textContent = '';
        setStageItem('stage_reboot', 'done', '옷봉 재시작 완료.');
        startConnectionPolling(ssid);
      }
    }, 1000);

  } catch (error) {
    setStageItem('stage_save', 'failed', '옷봉에 설정을 전달하지 못했습니다.');
    showProvisionFailure('블루투스 전송에 실패했습니다. 옷봉 전원과 블루투스 상태를 확인하세요.');
  }
}

function startConnectionPolling(targetSsid) {
  setStageItem('stage_wifi', 'active', `2.4 GHz Wi-Fi(${targetSsid})에 연결하고 있습니다...`);
  setStageItem('stage_cloud', 'active', '클라우드 서버 통신 및 Heartbeat를 대기하고 있습니다...');

  let pollCount = 0;
  const maxPolls = 25;

  provisionPollInterval = setInterval(async () => {
    pollCount++;
    try {
      // A gateway is invisible in a user's snapshot until its first Cloud
      // heartbeat is claimed. Retry the known hardware ID after reboot instead
      // of waiting for a snapshot that cannot contain an unclaimed device.
      const claim = currentBleGatewayId ? await claimDevice('gateways', currentBleGatewayId, { quietNotFound: true }) : null;
      if (claim?.reason === 'OTHER_ACCOUNT') {
        clearInterval(provisionPollInterval);
        setStageItem('stage_claim', 'failed', pairingBlockedMessage('gateways'));
        showProvisionFailure(pairingBlockedMessage('gateways'));
        return;
      }
      const snap = await api('/api/snapshot');
      model = mergeSnapshot(snap);
      const physical = (snap.gateways || []).filter(g => !String(g.gatewayId || '').startsWith('GW-SIM'));
      const onlineGateway = physical.find(g => g.gatewayId === currentBleGatewayId && Date.now() - Date.parse(g.lastSeen || 0) < 35000);

      if (onlineGateway) {
        clearInterval(provisionPollInterval);
        setStageItem('stage_wifi', 'done', `Wi-Fi 연결 완료 (SSID: ${onlineGateway.ssid || targetSsid})`);
        setStageItem('stage_cloud', 'done', '클라우드 서버 통신 확인 완료 (Heartbeat HTTP 200)');
        setStageItem('stage_claim', 'done', '내 계정에 옷봉 등록 완료');

        const progressTitle = $('#progressStageTitle');
        if (progressTitle) progressTitle.innerHTML = '<span style="color:#218451">✅ 옷봉 연결 완료!</span>';
        const detail = $('#progressStatusDetail');
        if (detail) detail.textContent = '옷봉이 인터넷과 내 옷장 서버에 정상 연결되었습니다. 이제 옷걸이가 자동으로 연동됩니다.';

        const successActions = $('#progressSuccessActions');
        if (successActions) successActions.hidden = false;

        render();
        return;
      }
    } catch (_) {}

    if (pollCount >= maxPolls) {
      clearInterval(provisionPollInterval);
      setStageItem('stage_wifi', 'failed', 'Wi-Fi/Cloud 연결 확인 시간 초과');
      setStageItem('stage_cloud', 'failed', '옷봉 heartbeat를 확인하지 못했습니다.');
      recordGatewayProvisionTimeout().catch(() => {});
      showProvisionFailure('설정 후 옷봉 heartbeat를 확인하지 못했습니다. Wi-Fi 비밀번호·신호·Cloud 연결 중 어느 단계인지는 현재 확인할 수 없습니다.');
    }
  }, 2000);
}

async function recordGatewayProvisionTimeout() {
  if (!currentBleGatewayId) return;
  await api(`/api/gateways/${encodeURIComponent(currentBleGatewayId)}/provisioning-status`, {
    method: 'POST',
    body: JSON.stringify({ detail: 'BLE 설정 후 50초 안에 Gateway heartbeat를 받지 못했습니다.' }),
  });
}

function showProvisionFailure(reasonMessage) {
  const progressTitle = $('#progressStageTitle');
  if (progressTitle) progressTitle.innerHTML = '<span style="color:var(--red)">❌ 연결 실패</span>';
  const detail = $('#progressStatusDetail');
  if (detail) detail.textContent = reasonMessage;
  const failActions = $('#progressFailureActions');
  if (failActions) failActions.hidden = false;
}

async function forgetHangerWifi() {
  if (!bleConfigCharacteristic) return setBleSetupMessage('먼저 옷봉을 블루투스로 연결하세요.', true);
  if (!window.confirm('옷봉에 저장된 Wi-Fi 연결을 제거할까요? 제거하면 옷봉은 오프라인이 되고, 다시 블루투스로 연결해야 합니다.')) return;
  try {
    const payload = new TextEncoder().encode(JSON.stringify({ action: 'forget' }));
    if (typeof bleConfigCharacteristic.writeValueWithResponse === 'function') await bleConfigCharacteristic.writeValueWithResponse(payload);
    else await bleConfigCharacteristic.writeValue(payload);
    setBleSetupMessage('옷봉 Wi-Fi 연결을 제거했습니다. 옷봉이 재시작됩니다.');
    rodReconnectStartedAt = 0;
    sessionStorage.removeItem('wardrobeRodReconnectStartedAt');
    setTimeout(() => $('#gatewayWifiDialog')?.close(), 2000);
    setTimeout(refresh, 3000);
  } catch (error) {
    setBleSetupMessage(bleErrorMessage(error, '옷봉 연결 제거'), true);
  }
}

function physicalHangerStatus() {
  const physical = (model.hangers || []).filter(h => !String(h.hangerId || '').startsWith('HC-000'));
  const hanger = physical.sort((a, b) => Date.parse(b.lastSeen || 0) - Date.parse(a.lastSeen || 0))[0];
  const age = hanger ? Date.now() - Date.parse(hanger.lastSeen || 0) : Infinity;
  return { hanger, online: !!hanger && age < 30000 };
}

function physicalGatewayStatus() {
  const now = Date.now();
  const physical = (model.gateways || []).filter(g => !String(g.gatewayId || '').startsWith('GW-SIM'));
  const latest = physical.sort((a, b) => Date.parse(b.lastSeen || 0) - Date.parse(a.lastSeen || 0))[0];
  return { gateway: latest, online: !!latest && now - Date.parse(latest.lastSeen || 0) < 30000 };
}

function setHangerBleMessage(message, error = false) {
  const target = $('#hangerBleMessage');
  if (!target) return;
  target.textContent = message;
  target.className = error ? 'error' : 'muted';
}

function showHangerBleStatus(info) {
  const detail = $('#hangerBleDetail');
  if (!detail) return;
  detail.hidden = false;
  const tagReader = info.nfcReady ? '정상 준비됨' : '준비 중 또는 결선 확인 필요';
  const garment = garmentNameForTag(info.tagUid);
  const tag = info.tagPresent && info.tagUid ? (garment ? `옷 감지됨 · ${garment}` : '새 옷 감지됨 · 옷 목록에서 이름을 등록하세요') : '걸린 옷 없음';
  const gateway = info.gatewayId ? '정상 통신 중' : (info.discoveredGatewayId ? '옷봉 신호 확인됨' : '옷봉 신호 탐색 중');
  const linked = info.gatewayId ? '내 옷봉에 등록됨' : '아직 등록되지 않음';
  const knownHanger = (model.hangers || []).find(item => item.hangerId === info.hangerId);
  detail.innerHTML = `<p><b>블루투스:</b> 이 기기와 연결됨</p><p><b>옷걸이:</b> ${esc(hangerDisplayName(knownHanger || { hangerId: info.hangerId }))}</p><p><b>내 옷봉 연결:</b> ${esc(linked)} · <b>무선 통신:</b> ${esc(gateway)}</p><p><b>옷 태그 읽기:</b> ${tagReader}</p><p><b>옷 상태:</b> ${esc(tag)}</p>`;
}

async function handleHangerBleStatus(value) {
  try {
    const info = JSON.parse(new TextDecoder().decode(value));
    setHangerBleMessage(info.message || '옷걸이 상태를 받았습니다.', /error|failed/i.test(info.state || ''));
    showHangerBleStatus(info);
    const gatewayId = info.gatewayId || info.discoveredGatewayId;
    if (!info.hangerId) return;
    const pairing = await refreshBleOwnership('hangers', info.hangerId);
    const nameEl = $('#hangerBleDeviceName');
    if (nameEl) nameEl.textContent = `${pairing.displayName || neutralBleLabel('hangers', info.hangerId)} 연결됨`;
    if (pairing.ownership === 'OTHER_ACCOUNT') {
      setHangerBleMessage(pairingBlockedMessage('hangers'), true);
      const pairBtn = $('#pairPhysicalHanger');
      if (pairBtn) pairBtn.hidden = true;
      return;
    }
    if (gatewayId) await claimDevice('gateways', gatewayId, { quietNotFound: true });
    if (gatewayId) await claimDevice('hangers', info.hangerId, { quietNotFound: true });
  } catch (_) {
    setHangerBleMessage('옷걸이 상태를 읽지 못했습니다.', true);
  }
}

async function claimDevice(kind, deviceId, { quietNotFound = false } = {}) {
  if (!deviceId) return;
  const key = `${kind}:${deviceId}`;
  if (claimedDeviceIds.has(key)) return { ok: false, reason: 'PENDING' };
  claimedDeviceIds.add(key);
  try {
    const item = await api(`/api/${kind}/${encodeURIComponent(deviceId)}/claim`, { method: 'POST' });
    refresh();
    return { ok: true, item };
  } catch (error) {
    if (error.status === 409) {
      const message = pairingBlockedMessage(kind);
      if (kind === 'gateways') setBleSetupMessage(message, true);
      else setHangerBleMessage(message, true);
      return { ok: false, reason: 'OTHER_ACCOUNT' };
    }
    if (error.status !== 404 || !quietNotFound) {
      if (kind === 'gateways') setBleSetupMessage(error.message, true);
      else setHangerBleMessage(error.message, true);
    }
    return { ok: false, reason: error.status === 404 ? 'NOT_SEEN' : 'ERROR' };
  } finally {
    claimedDeviceIds.delete(key);
  }
}

async function writeHangerBle(action, extra = {}) {
  if (!hangerBleConfigCharacteristic) return setHangerBleMessage('먼저 옷걸이를 블루투스로 연결하세요.', true);
  try {
    const payload = new TextEncoder().encode(JSON.stringify({ action, ...extra }));
    if (typeof hangerBleConfigCharacteristic.writeValueWithResponse === 'function') await hangerBleConfigCharacteristic.writeValueWithResponse(payload);
    else await hangerBleConfigCharacteristic.writeValue(payload);
  } catch (error) {
    setHangerBleMessage(bleErrorMessage(error, '옷걸이 요청'), true);
  }
}

async function connectPhysicalHangerBluetooth() {
  if (!navigator.bluetooth || !window.isSecureContext) {
    setHangerBleMessage('이 기능은 블루투스가 켜진 Chrome에서 HTTPS 또는 localhost로 열어야 합니다.', true);
    return;
  }
  const button = $('#connectPhysicalHangerBle');
  if (button) {
    button.disabled = true;
    button.textContent = '옷걸이 찾는 중… 잠시만 기다려 주세요';
  }
  try {
    setHangerBleMessage('브라우저 블루투스 선택창에서 “스마트 옷걸이 · 고유 코드”를 선택하세요.');
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [HANGER_BLE_SERVICE_UUID] }],
      optionalServices: [HANGER_BLE_SERVICE_UUID],
    });
    const gatt = await device.gatt.connect();
    const service = await gatt.getPrimaryService(HANGER_BLE_SERVICE_UUID);
    hangerBleConfigCharacteristic = await service.getCharacteristic(HANGER_BLE_CONFIG_UUID);
    const status = await service.getCharacteristic(HANGER_BLE_STATUS_UUID);
    await status.startNotifications();
    status.addEventListener('characteristicvaluechanged', event => handleHangerBleStatus(event.target.value));
    const knownHanger = (model.hangers || []).find(hanger => device.name?.includes(hanger.hangerId));
    const nameEl = $('#hangerBleDeviceName');
    if (nameEl) nameEl.textContent = `${knownHanger ? hangerDisplayName(knownHanger) : neutralBleLabel('hangers', device.name || '')} 연결됨`;
    handleHangerBleStatus(await status.readValue());
    const pairBtn = $('#pairPhysicalHanger');
    if (pairBtn) pairBtn.hidden = false;
    const forgetBtn = $('#forgetPhysicalHanger');
    if (forgetBtn) forgetBtn.hidden = false;
    await writeHangerBle('status');
  } catch (error) {
    setHangerBleMessage(bleErrorMessage(error, '옷걸이 연결'), true);
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = '옷걸이 찾기 (블루투스)';
    }
  }
}

async function forgetPhysicalHanger() {
  if (!hangerBleConfigCharacteristic) return setHangerBleMessage('먼저 옷걸이를 블루투스로 연결하세요.', true);
  if (!window.confirm('이 옷걸이의 옷봉 연결을 제거할까요? 제거 후에는 태그 상태가 웹에 전송되지 않습니다.')) return;
  await writeHangerBle('forget');
  setTimeout(refresh, 1500);
}

// -------------------------------------------------------------
// Gateway Settings & Diagnostics Modals
// -------------------------------------------------------------
function openGatewaySettings(gatewayId) {
  const g = (model.gateways || []).find(x => x.gatewayId === gatewayId);
  if (!g) return;
  const dialog = $('#gatewaySettingsDialog');
  if (!dialog) return;

  $('#gwSettingsTitle').textContent = `옷봉 설정 · ${g.name || g.gatewayId}`;
  const nameInput = $('#inputGwName');
  if (nameInput) nameInput.value = g.name || `${ownerDisplayName()}의 옷봉`;

  const btnSaveName = $('#btnSaveGwName');
  if (btnSaveName) {
    btnSaveName.onclick = async () => {
      const newName = String(nameInput.value || '').trim();
      if (!newName) return alert('옷봉 이름을 입력해 주세요.');
      try {
        await api(`/api/gateways/${encodeURIComponent(gatewayId)}`, { method: 'PATCH', body: JSON.stringify({ name: newName }) });
        toast('옷봉 이름을 변경했습니다.');
        dialog.close();
        refresh();
      } catch (e) { alert(e.message); }
    };
  }

  const btnWifi = $('#btnGwChangeWifi');
  if (btnWifi) {
    btnWifi.onclick = () => {
      dialog.close();
      window.showGatewayWifiHelp();
    };
  }

  const btnRefresh = $('#btnGwRefresh');
  if (btnRefresh) {
    btnRefresh.onclick = () => {
      toast('옷봉 연결 상태를 다시 확인합니다.');
      refresh();
      dialog.close();
    };
  }

  const btnRemove = $('#btnGwRemove');
  if (btnRemove) {
    btnRemove.onclick = async () => {
      if (!window.confirm('이 옷봉을 내 계정에서 제거하시겠습니까? 실제 전원은 꺼지지 않으며, 나중에 다시 연결할 수 있습니다.')) return;
      try {
        await api(`/api/gateways/${encodeURIComponent(gatewayId)}`, { method: 'DELETE' });
        toast('옷봉 등록을 제거했습니다.');
        dialog.close();
        refresh();
      } catch (e) { alert(e.message); }
    };
  }

  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
}

function openGatewayDiagnostics(gatewayId) {
  const g = (model.gateways || []).find(x => x.gatewayId === gatewayId);
  if (!g) return;
  const dialog = $('#gatewayDiagDialog');
  if (!dialog) return;

  const isOnline = Date.now() - Date.parse(g.lastSeen || 0) < 30000;
  $('#gwDiagTitle').textContent = `옷봉 상세 진단 · ${g.name || g.gatewayId}`;

  const content = $('#gwDiagContent');
  if (content) {
    content.innerHTML = `
      <span class="label">장비 ID</span><span class="val">${esc(g.gatewayId)}</span>
      <span class="label">장비 상태</span><span class="val">${isOnline ? '<b style="color:#218451">● ONLINE (정상 연결됨)</b>' : '<b style="color:var(--red)">● OFFLINE (확인 필요)</b>'}</span>
      <span class="label">접속 SSID</span><span class="val"><b>${esc(g.ssid || '2.4 GHz Network')}</b></span>
      <span class="label">수신 감도(RSSI)</span><span class="val">${formatRssi(g.rssi, isOnline)}</span>
      <span class="label">할당 IP 주소</span><span class="val">${esc(g.ip || (isOnline ? '정상 획득' : '-'))}</span>
      <span class="label">클라우드 통신</span><span class="val">${isOnline ? '정상 통신 중 (Heartbeat HTTP 200)' : '통신 두절 (신호 없음)'}</span>
      <span class="label">Wi-Fi 채널</span><span class="val">채널 ${g.channel || '-'}</span>
      <span class="label">마지막 Heartbeat</span><span class="val">${g.lastSeen ? `${new Date(g.lastSeen).toLocaleTimeString()} (${timeAgo(g.lastSeen)})` : '신호 없음'}</span>
      <span class="label">펌웨어 버전</span><span class="val">${esc(g.firmwareVersion || '1.0.0')}</span>
      <span class="label">연결된 옷걸이</span><span class="val">${linkedHangerCount(g.gatewayId)}개</span>
    `;
  }

  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
}

// -------------------------------------------------------------
// Hanger Settings & Diagnostics Modals
// -------------------------------------------------------------
function openHangerSettings(hangerId) {
  const h = (model.hangers || []).find(x => x.hangerId === hangerId);
  if (!h) return;
  const dialog = $('#hangerSettingsDialog');
  if (!dialog) return;

  $('#hangerSettingsTitle').textContent = `옷걸이 설정 · ${hangerDisplayName(h)}`;
  const nameInput = $('#inputHangerName');
  if (nameInput) nameInput.value = h.alias || hangerDisplayName(h);

  const btnSaveName = $('#btnSaveHangerName');
  if (btnSaveName) {
    btnSaveName.onclick = async () => {
      const newName = String(nameInput.value || '').trim();
      if (!newName) return alert('옷걸이 이름을 입력해 주세요.');
      try {
        await api(`/api/hangers/${encodeURIComponent(hangerId)}`, { method: 'PATCH', body: JSON.stringify({ name: newName }) });
        toast('옷걸이 이름을 변경했습니다.');
        dialog.close();
        refresh();
      } catch (e) { alert(e.message); }
    };
  }

  const btnRemove = $('#btnHangerRemove');
  if (btnRemove) {
    btnRemove.onclick = async () => {
      if (!window.confirm('이 옷걸이를 내 옷장에서 등록 제거할까요? 실제 전원은 꺼지지 않으며, 나중에 다시 연결할 수 있습니다.')) return;
      try {
        await api(`/api/hangers/${encodeURIComponent(hangerId)}`, { method: 'DELETE' });
        toast('옷걸이 등록을 제거했습니다.');
        dialog.close();
        refresh();
      } catch (e) { alert(e.message); }
    };
  }

  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
}

function openHangerDiagnostics(hangerId) {
  const h = (model.hangers || []).find(x => x.hangerId === hangerId);
  if (!h) return;
  const dialog = $('#hangerDiagDialog');
  if (!dialog) return;

  const isOnline = Date.now() - Date.parse(h.lastSeen || 0) < 30000;
  $('#hangerDiagTitle').textContent = `옷걸이 상세 진단 · ${hangerDisplayName(h)}`;

  const content = $('#hangerDiagContent');
  if (content) {
    content.innerHTML = `
      <span class="label">옷걸이 ID</span><span class="val">${esc(h.hangerId)}</span>
      <span class="label">장비 상태</span><span class="val">${isOnline ? '<b style="color:#218451">● ONLINE (정상 연결됨)</b>' : '<b style="color:var(--red)">● OFFLINE</b>'}</span>
      <span class="label">PN532 상태</span><span class="val">${getPn532StatusHtml(h)}</span>
      <span class="label">감지된 태그 UID</span><span class="val">${esc(h.tagUid || '태그 없음')}</span>
      <span class="label">현재 감지 옷</span><span class="val">${esc(garmentNameForHanger(h))}</span>
      <span class="label">ESP-NOW 통신</span><span class="val">${h.gatewayId ? `옷봉(${esc(h.gatewayId)})과 정상 통신 중` : '신호 탐색 중'}</span>
      <span class="label">통신 채널</span><span class="val">채널 ${h.channel || '-'}</span>
      <span class="label">마지막 신호 시각</span><span class="val">${h.lastSeen ? `${new Date(h.lastSeen).toLocaleTimeString()} (${timeAgo(h.lastSeen)})` : '신호 없음'}</span>
      <span class="label">펌웨어 버전</span><span class="val">${esc(h.firmwareVersion || '1.0.0')}</span>
    `;
  }

  if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
}

function renderDeviceManagement() {
  if (adminActive()) return;
  const panel = $('#deviceManagement');
  if (!panel) return;

  const gateways = (model.gateways || []).filter(g => !String(g.gatewayId || '').startsWith('GW-SIM'));
  const hangers = (model.hangers || []).filter(h => !String(h.hangerId || '').startsWith('HC-000'));
  const isOnline = item => Date.now() - Date.parse(item.lastSeen || 0) < 30000;

  // 1. Gateway Section HTML
  let gatewayContent = '';
  if (gateways.length === 0) {
    gatewayContent = `
      <div class="empty-box">
        <p>등록된 옷봉이 없습니다. 처음 한 번만 2.4 GHz Wi-Fi를 연결해 주세요.</p>
        <button type="button" id="btnAddNewGateway" class="primary">+ 새 옷봉 연결</button>
      </div>`;
  } else {
    const cards = gateways.map(g => {
      const online = isOnline(g);
      const statusBadge = online
        ? '<span class="pill status-pill-online">● 온라인</span>'
        : '<span class="pill status-pill-offline">● 오프라인</span>';
      const wifiStatus = online ? (g.ssid ? `● 연결됨 (${esc(g.ssid)})` : '● 연결됨') : '● 연결 끊김';
      const cloudStatus = online ? '● 연결됨' : '● 연결 끊김';
      return `
        <div class="device-box">
          <div class="device-box-header">
            <div>
              <div class="device-box-title">${esc(g.name || `${ownerDisplayName()}의 옷봉`)}</div>
              <div class="device-box-id">${esc(g.gatewayId)}</div>
            </div>
            ${statusBadge}
          </div>
          <div class="device-info-grid">
            <span class="label">장비 상태</span><span class="val">${online ? '온라인 (정상)' : '오프라인 (확인 필요)'}</span>
            <span class="label">Wi-Fi</span><span class="val"><b>${wifiStatus}</b></span>
            <span class="label">Wi-Fi 신호</span><span class="val">${formatRssi(g.rssi, online)}</span>
            <span class="label">IP 주소</span><span class="val">${esc(g.ip || (online ? '연결됨' : '-'))}</span>
            <span class="label">클라우드</span><span class="val">${cloudStatus}</span>
            <span class="label">마지막 신호</span><span class="val">${timeAgo(g.lastSeen)}</span>
            <span class="label">연결 옷걸이</span><span class="val">${linkedHangerCount(g.gatewayId)}개</span>
          </div>
          <div class="actions">
            <button type="button" data-gateway-action="settings" data-id="${esc(g.gatewayId)}">설정</button>
            <button type="button" class="ghost" style="color:var(--ink);border:1px solid #cbd4cd" data-gateway-action="diagnose" data-id="${esc(g.gatewayId)}">진단</button>
          </div>
        </div>`;
    }).join('');
    gatewayContent = `<div class="device-card-grid">${cards}</div>`;
  }

  // 2. Hanger Section HTML
  let hangerContent = '';
  if (hangers.length === 0) {
    hangerContent = `
      <div class="empty-box">
        <p>등록된 옷걸이가 없습니다. 블루투스로 옷봉에 옷걸이를 연결하세요.</p>
        <button type="button" id="btnAddNewHanger" class="primary">+ 옷걸이 연결</button>
      </div>`;
  } else {
    const cards = hangers.map(h => {
      const online = isOnline(h);
      const statusBadge = online
        ? '<span class="pill status-pill-online">● 온라인</span>'
        : '<span class="pill status-pill-offline">● 오프라인</span>';
      return `
        <div class="device-box">
          <div class="device-box-header">
            <div>
              <div class="device-box-title">${esc(hangerDisplayName(h))}</div>
              <div class="device-box-id">${esc(h.hangerId)}</div>
            </div>
            ${statusBadge}
          </div>
          <div class="device-info-grid">
            <span class="label">장비 상태</span><span class="val">${online ? '온라인 (통신 중)' : '오프라인'}</span>
            <span class="label">PN532 상태</span><span class="val">${getPn532StatusHtml(h)}</span>
            <span class="label">감지 상태</span><span class="val">${esc(hangerClothingStatus(h))}</span>
            <span class="label">걸린 옷</span><span class="val">${esc(garmentNameForHanger(h))}</span>
            <span class="label">통신 채널</span><span class="val">채널 ${h.channel || '-'}</span>
            <span class="label">마지막 신호</span><span class="val">${timeAgo(h.lastSeen)}</span>
          </div>
          <div class="actions">
            <button type="button" data-hanger-action="settings" data-id="${esc(h.hangerId)}">설정</button>
            <button type="button" class="ghost" style="color:var(--ink);border:1px solid #cbd4cd" data-hanger-action="diagnose" data-id="${esc(h.hangerId)}">진단</button>
          </div>
        </div>`;
    }).join('');
    hangerContent = `<div class="device-card-grid">${cards}</div>`;
  }

  // 3. Render Combined HTML
  panel.innerHTML = `
    <div class="title" style="margin-bottom:12px">
      <div>
        <h3>내 장비 관리</h3>
        <p class="muted">계정에 등록된 옷봉 게이트웨이와 옷걸이의 연결 상태를 실시간으로 확인하고 관리합니다.</p>
      </div>
    </div>
    <div style="margin-top:14px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h4>옷봉 (게이트웨이)</h4>
        ${gateways.length > 0 ? '<button type="button" class="ghost" id="btnAddAnotherGateway" style="padding:5px 10px;font-size:12px;color:var(--green);border:1px solid #347454">+ 옷봉 추가 연결</button>' : ''}
      </div>
      ${gatewayContent}
    </div>
    <div style="margin-top:24px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h4>스마트 옷걸이</h4>
        ${hangers.length > 0 ? '<button type="button" class="ghost" id="btnAddAnotherHanger" style="padding:5px 10px;font-size:12px;color:var(--green);border:1px solid #347454">+ 옷걸이 추가 연결</button>' : ''}
      </div>
      ${hangerContent}
    </div>`;

  // 4. Attach Event Handlers
  const addGwBtn = $('#btnAddNewGateway') || $('#btnAddAnotherGateway');
  if (addGwBtn) addGwBtn.onclick = window.showGatewayWifiHelp;

  const addHgBtn = $('#btnAddNewHanger') || $('#btnAddAnotherHanger');
  if (addHgBtn) addHgBtn.onclick = window.showHangerBleHelp;

  panel.querySelectorAll('[data-gateway-action="settings"]').forEach(btn => {
    btn.onclick = () => openGatewaySettings(btn.dataset.id);
  });

  panel.querySelectorAll('[data-gateway-action="diagnose"]').forEach(btn => {
    btn.onclick = () => openGatewayDiagnostics(btn.dataset.id);
  });

  panel.querySelectorAll('[data-hanger-action="settings"]').forEach(btn => {
    btn.onclick = () => openHangerSettings(btn.dataset.id);
  });

  panel.querySelectorAll('[data-hanger-action="diagnose"]').forEach(btn => {
    btn.onclick = () => openHangerDiagnostics(btn.dataset.id);
  });
}

function installGatewayWifiSetup() {
  const setupView = $('#setup');
  if (!setupView || $('#deviceManagement')) return;

  setupView.innerHTML = setupView.innerHTML.replaceAll('C3', '옷봉 게이트웨이');
  [...setupView.querySelectorAll('article.panel')]
    .filter(panel => /게이트웨이 Wi-Fi 연결|연결 정보|옷봉 연결 상태|옷걸이 연결 상태/.test(panel.textContent))
    .forEach(panel => panel.remove());

  const devicePanel = document.createElement('article');
  devicePanel.className = 'panel';
  devicePanel.id = 'deviceManagement';
  devicePanel.innerHTML = '<h3>내 장비 관리</h3><p>장비 목록을 불러오는 중입니다.</p>';
  setupView.append(devicePanel);

  // Modal 1: Gateway Wi-Fi Provisioning Dialog
  const dialog = document.createElement('dialog');
  dialog.id = 'gatewayWifiDialog';
  dialog.innerHTML = `
    <div class="title">
      <h2 id="gwModalTitle">옷봉 2.4 GHz Wi-Fi 연결</h2>
      <button type="button" class="ghost" id="closeGatewayWifiHelp">닫기</button>
    </div>
    <div id="bleStepConnect">
      <p><b>처음 한 번만 설정하면 됩니다.</b> PC·휴대폰의 Wi-Fi는 바꾸지 않고, 블루투스로 옷봉에 연결할 2.4 GHz Wi-Fi 정보를 전달합니다.</p>
      <button type="button" id="connectHangerBle" class="primary" style="margin:12px 0;width:100%">옷봉 찾기 (블루투스)</button>
      <p id="bleDeviceName" class="muted"></p>
      <p id="bleSetupMessage" class="muted">블루투스 연결을 시작하세요.</p>
      <form id="bleWifiForm" method="post" action="/" hidden style="margin-top:16px">
        <label>옷봉이 찾은 주변 2.4 GHz Wi-Fi
          <select name="ssid" id="nearbyWifiChoices" required>
            <option value="">옷봉을 연결하면 목록이 표시됩니다</option>
          </select>
        </label>
        <button type="button" id="scanHangerWifi" class="ghost" style="margin-bottom:8px;color:var(--ink);border:1px solid #cbd4cd">주변 Wi-Fi 다시 검색</button>
        <label>선택한 Wi-Fi 비밀번호
          <input name="password" type="password" placeholder="비밀번호 입력">
        </label>
        <label>서버 주소
          <input name="server" required readonly style="background:#f5f7f6;color:#555">
        </label>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button type="submit" class="primary" style="flex:1">옷봉에 저장하고 연결 시작</button>
          <button type="button" class="ghost" id="forgetHangerWifi" style="color:var(--red);border:1px solid #e78e88">연결 초기화</button>
        </div>
      </form>
    </div>
    <div id="bleStepProgress" hidden style="padding:10px 0">
      <h3 id="progressStageTitle">연결 진행 중…</h3>
      <div style="margin:16px 0">
        <div class="stage-item" id="stage_save"><span class="stage-icon">⏳</span> <b>1. Wi-Fi 정보 전달 및 저장</b></div>
        <div class="stage-item" id="stage_reboot"><span class="stage-icon">⚪</span> <b>2. 옷봉 재시작</b> <span id="rebootTimer" class="muted"></span></div>
        <div class="stage-item" id="stage_wifi"><span class="stage-icon">⚪</span> <b>3. 2.4 GHz Wi-Fi 연결</b></div>
        <div class="stage-item" id="stage_cloud"><span class="stage-icon">⚪</span> <b>4. 클라우드 서버 통신 확인</b></div>
        <div class="stage-item" id="stage_claim"><span class="stage-icon">⚪</span> <b>5. 내 계정 등록 및 연동 완료</b></div>
      </div>
      <p id="progressStatusDetail" class="muted" style="min-height:24px">옷봉에 설정을 전달하고 있습니다…</p>
      <div id="progressFailureActions" hidden style="margin-top:16px;display:flex;gap:8px">
        <button type="button" id="btnRetryWifiPassword" class="primary" style="flex:1">비밀번호 다시 입력</button>
        <button type="button" id="btnSelectAnotherWifi" class="ghost" style="flex:1;color:var(--ink);border:1px solid #cbd4cd">다른 Wi-Fi 선택</button>
      </div>
      <div id="progressSuccessActions" hidden style="margin-top:16px">
        <button type="button" id="btnCloseProgressSuccess" class="primary" style="width:100%">확인 (대시보드로 이동)</button>
      </div>
    </div>`;

  const serverInput = dialog.querySelector('input[name="server"]');
  if (serverInput) serverInput.value = window.location.origin;
  document.body.append(dialog);

  const showGatewayWifiHelp = () => {
    resetProvisionProgressUI();
    try {
      if (typeof dialog.showModal === 'function') {
        if (!dialog.open) dialog.showModal();
        return;
      }
    } catch (_) {}
    window.alert('PC의 블루투스를 켠 뒤 옷봉 찾기를 누르고 “스마트 옷봉 · 고유 코드”를 선택하세요.');
  };
  window.showGatewayWifiHelp = showGatewayWifiHelp;

  const closeGatewayWifiHelpBtn = $('#closeGatewayWifiHelp');
  if (closeGatewayWifiHelpBtn) closeGatewayWifiHelpBtn.onclick = () => {
    resetProvisionProgressUI();
    dialog.close();
  };

  const connectHangerBleBtn = $('#connectHangerBle');
  if (connectHangerBleBtn) connectHangerBleBtn.onclick = connectHangerBluetooth;

  const scanHangerWifiBtn = $('#scanHangerWifi');
  if (scanHangerWifiBtn) scanHangerWifiBtn.onclick = scanHangerWifi;

  const forgetHangerWifiBtn = $('#forgetHangerWifi');
  if (forgetHangerWifiBtn) forgetHangerWifiBtn.onclick = forgetHangerWifi;

  const bleWifiFormEl = $('#bleWifiForm');
  if (bleWifiFormEl) bleWifiFormEl.onsubmit = saveHangerWifi;

  const btnRetryPass = $('#btnRetryWifiPassword');
  if (btnRetryPass) {
    btnRetryPass.onclick = () => {
      resetProvisionProgressUI();
      const form = $('#bleWifiForm');
      if (form) form.hidden = false;
    };
  }

  const btnSelectOther = $('#btnSelectAnotherWifi');
  if (btnSelectOther) {
    btnSelectOther.onclick = () => {
      resetProvisionProgressUI();
      const form = $('#bleWifiForm');
      if (form) form.hidden = false;
      scanHangerWifi();
    };
  }

  const btnCloseSucc = $('#btnCloseProgressSuccess');
  if (btnCloseSucc) {
    btnCloseSucc.onclick = () => {
      resetProvisionProgressUI();
      dialog.close();
    };
  }

  // Modal 2: Gateway Settings Dialog
  const gwSettingsDialog = document.createElement('dialog');
  gwSettingsDialog.id = 'gatewaySettingsDialog';
  gwSettingsDialog.innerHTML = `
    <div class="title">
      <h2 id="gwSettingsTitle">옷봉 설정</h2>
      <button type="button" class="ghost" id="closeGwSettingsDialog">닫기</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:16px">
      <div class="panel" style="padding:14px;background:#f8faf8">
        <label style="margin:0 0 6px 0;font-size:13px">옷봉 이름 변경</label>
        <div style="display:flex;gap:8px">
          <input id="inputGwName" placeholder="새 옷봉 이름 입력" style="flex:1">
          <button type="button" id="btnSaveGwName" class="primary">변경</button>
        </div>
      </div>
      <button type="button" id="btnGwChangeWifi" class="ghost" style="color:var(--ink);border:1px solid #cbd4cd;padding:12px;text-align:left;border-radius:12px">
        <b>📡 Wi-Fi 변경</b><br><small class="muted">블루투스로 2.4 GHz Wi-Fi 연결을 다시 설정합니다.</small>
      </button>
      <button type="button" id="btnGwRefresh" class="ghost" style="color:var(--ink);border:1px solid #cbd4cd;padding:12px;text-align:left;border-radius:12px">
        <b>🔄 장비 상태 다시 확인</b><br><small class="muted">서버와 옷봉의 최신 연결 상태를 다시 불러옵니다.</small>
      </button>
      <div style="border-top:1px solid #e7ece8;margin-top:8px;padding-top:12px">
        <button type="button" id="btnGwRemove" class="ghost" style="color:var(--red);border:1px solid #e78e88;width:100%;padding:11px;font-weight:600">
          🗑️ 이 옷봉을 내 계정에서 등록 해제
        </button>
      </div>
    </div>`;
  document.body.append(gwSettingsDialog);
  $('#closeGwSettingsDialog').onclick = () => gwSettingsDialog.close();

  // Modal 3: Gateway Diagnostics Dialog
  const gwDiagDialog = document.createElement('dialog');
  gwDiagDialog.id = 'gatewayDiagDialog';
  gwDiagDialog.innerHTML = `
    <div class="title">
      <h2 id="gwDiagTitle">옷봉 상세 진단</h2>
      <button type="button" class="ghost" id="closeGwDiagDialog">닫기</button>
    </div>
    <div id="gwDiagContent" class="device-info-grid" style="grid-template-columns:120px 1fr;margin-top:16px;font-size:14px;padding:14px">
    </div>
    <div style="margin-top:16px;text-align:right">
      <button type="button" id="btnCloseGwDiag" class="primary" style="width:100%">확인</button>
    </div>`;
  document.body.append(gwDiagDialog);
  $('#closeGwDiagDialog').onclick = () => gwDiagDialog.close();
  $('#btnCloseGwDiag').onclick = () => gwDiagDialog.close();

  // Modal 4: Hanger Settings Dialog
  const hangerSettingsDialog = document.createElement('dialog');
  hangerSettingsDialog.id = 'hangerSettingsDialog';
  hangerSettingsDialog.innerHTML = `
    <div class="title">
      <h2 id="hangerSettingsTitle">옷걸이 설정</h2>
      <button type="button" class="ghost" id="closeHangerSettingsDialog">닫기</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px;margin-top:16px">
      <div class="panel" style="padding:14px;background:#f8faf8">
        <label style="margin:0 0 6px 0;font-size:13px">옷걸이 이름 변경</label>
        <div style="display:flex;gap:8px">
          <input id="inputHangerName" placeholder="새 옷걸이 이름 입력" style="flex:1">
          <button type="button" id="btnSaveHangerName" class="primary">변경</button>
        </div>
      </div>
      <div style="border-top:1px solid #e7ece8;margin-top:8px;padding-top:12px">
        <button type="button" id="btnHangerRemove" class="ghost" style="color:var(--red);border:1px solid #e78e88;width:100%;padding:11px;font-weight:600">
          🗑️ 이 옷걸이를 내 옷장에서 등록 해제
        </button>
      </div>
    </div>`;
  document.body.append(hangerSettingsDialog);
  $('#closeHangerSettingsDialog').onclick = () => hangerSettingsDialog.close();

  // Modal 5: Hanger Diagnostics Dialog
  const hangerDiagDialog = document.createElement('dialog');
  hangerDiagDialog.id = 'hangerDiagDialog';
  hangerDiagDialog.innerHTML = `
    <div class="title">
      <h2 id="hangerDiagTitle">옷걸이 상세 진단</h2>
      <button type="button" class="ghost" id="closeHangerDiagDialog">닫기</button>
    </div>
    <div id="hangerDiagContent" class="device-info-grid" style="grid-template-columns:120px 1fr;margin-top:16px;font-size:14px;padding:14px">
    </div>
    <div style="margin-top:16px;text-align:right">
      <button type="button" id="btnCloseHangerDiag" class="primary" style="width:100%">확인</button>
    </div>`;
  document.body.append(hangerDiagDialog);
  $('#closeHangerDiagDialog').onclick = () => hangerDiagDialog.close();
  $('#btnCloseHangerDiag').onclick = () => hangerDiagDialog.close();

  // Modal 6: Hanger BLE Dialog
  const hangerDialog = document.createElement('dialog');
  hangerDialog.id = 'hangerBleDialog';
  hangerDialog.innerHTML = `
    <div class="title">
      <h2>옷걸이 연결·옷 태그 확인</h2>
      <button type="button" class="ghost" id="closeHangerBleHelp">닫기</button>
    </div>
    <p><b>옷걸이는 Wi-Fi를 설정하지 않습니다.</b> 옷봉과 자동으로 통신합니다. 이 화면은 옷걸이를 처음 연결하거나, 연결을 바꾸고 옷 태그 상태를 확인할 때만 사용합니다.</p>
    <ol>
      <li><b>옷걸이 찾기</b>를 누릅니다.</li>
      <li>브라우저 선택창에서 <b>스마트 옷걸이 · 고유 코드</b>를 선택합니다.</li>
      <li><b>옷봉과 연결</b>을 누르면 현재 내 옷봉에 등록됩니다.</li>
      <li>옷 태그를 대면 옷 감지 상태가 표시됩니다.</li>
    </ol>
    <button type="button" id="connectPhysicalHangerBle" class="primary" style="width:100%;margin:12px 0">옷걸이 찾기 (블루투스)</button>
    <p id="hangerBleDeviceName" class="muted"></p>
    <p id="hangerBleMessage" class="muted">블루투스 연결을 시작하세요.</p>
    <section id="hangerBleDetail" class="panel" style="padding:12px;margin-top:12px" hidden></section>
    <div style="display:flex;gap:8px;margin-top:12px">
      <button type="button" id="pairPhysicalHanger" class="primary" style="flex:1" hidden>옷봉과 연결</button>
      <button type="button" class="ghost" id="forgetPhysicalHanger" style="color:var(--red);border:1px solid #e78e88" hidden>옷걸이 연결 제거</button>
    </div>`;
  document.body.append(hangerDialog);

  const showHangerBleHelp = () => {
    if (typeof hangerDialog.showModal === 'function' && !hangerDialog.open) hangerDialog.showModal();
  };
  window.showHangerBleHelp = showHangerBleHelp;

  const closeHangerBleHelpBtn = $('#closeHangerBleHelp');
  if (closeHangerBleHelpBtn) closeHangerBleHelpBtn.onclick = () => hangerDialog.close();

  const connectPhysicalHangerBleBtn = $('#connectPhysicalHangerBle');
  if (connectPhysicalHangerBleBtn) connectPhysicalHangerBleBtn.onclick = connectPhysicalHangerBluetooth;

  const pairPhysicalHangerBtn = $('#pairPhysicalHanger');
  if (pairPhysicalHangerBtn) pairPhysicalHangerBtn.onclick = () => writeHangerBle('pair');

  const forgetPhysicalHangerBtn = $('#forgetPhysicalHanger');
  if (forgetPhysicalHangerBtn) forgetPhysicalHangerBtn.onclick = forgetPhysicalHanger;

  renderDeviceManagement();
}

installGatewayWifiSetup();
$('#navSim')?.remove();
$('#simulation')?.remove();
setInterval(renderDeviceManagement, 2000);
initAllComboboxes();
token ? enter() : showAuth();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
