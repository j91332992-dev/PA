// ========================================
// 스마트 옷장 - 메인 앱
// ========================================

const TARGET_COUNT = 5;

const CLOTH_TYPES = [
  { emoji: '👕', label: '상의' },
  { emoji: '👖', label: '하의' },
  { emoji: '🧥', label: '아우터' },
  { emoji: '👗', label: '원피스' },
  { emoji: '🧶', label: '니트' },
  { emoji: '👔', label: '셔츠' },
  { emoji: '🩳', label: '반바지' },
  { emoji: '🧥', label: '자켓' },
];

const POSITIONS = [
  { left: '5%',  top: '15%', rotate: -6 },
  { left: '25%', top: '5%',  rotate: 4 },
  { left: '45%', top: '20%', rotate: -3 },
  { left: '62%', top: '8%',  rotate: 7 },
  { left: '20%', top: '55%', rotate: 5 },
  { left: '40%', top: '60%', rotate: -5 },
  { left: '58%', top: '55%', rotate: 3 },
];

const CATEGORIES = {
  outer:  { emoji: '🧥', name: '아우터' },
  top:    { emoji: '👕', name: '상의' },
  bottom: { emoji: '👖', name: '하의' },
  dress:  { emoji: '👗', name: '원피스' },
};

const SEASONS = {
  spring: '🌸 봄',
  summer: '☀️ 여름',
  fall:   '🍂 가을',
  winter: '❄️ 겨울',
  allseason: '🌀 사계절',
};

// ===== 상태 =====
const state = {
  count: 0,
  clothes: [],
  currentView: 'home',
  started: false,
  sort: 'date',
  modal: {
    photoDataUrl: null,
    selectedCategory: null,
  },
};

// ===== 초기화 =====
function init() {
  // 첫 화면 = 옷장 페이지
  document.getElementById('page-closet').classList.add('active');

  setDate();
  setupAddBtn();
  setupAddModal();
  setupStartButton();
  setupFab();
  setupNav();
  setupClosetTabs();
  setupClosetSort();
  loadClothes();
  renderCloset();

  // 이미 5개 이상이면 스타팅 버튼 표시
  if (state.clothes.length >= 5) {
    showStartButton();
  }
}

function setupFab() {
  const fab = document.getElementById('fabAdd');
  if (fab) fab.onclick = () => openAddModal();
}

function setDate() {
  const now = new Date();
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  const dateStr = `${now.getFullYear()}년 ${now.getMonth() + 1}월 ${now.getDate()}일 ${days[now.getDay()]}요일`;
  document.getElementById('date').textContent = dateStr;
}

// ========================================
// 옷장 일러스트 (자동 데모)
// ========================================
let demoInterval = null;

function addCloth(cloth = null) {
  if (state.count >= TARGET_COUNT && !cloth) return;

  const wardrobeBox = document.getElementById('wardrobeBox');
  const wardrobeCard = document.getElementById('wardrobeCard');
  const emptyText = document.getElementById('emptyText');

  if (state.count === 0) {
    wardrobeCard.classList.remove('empty');
    emptyText.style.display = 'none';
  }

  // 사용자 추가 사진이 가득 찬 상태면 마지막 이모지 제거
  if (cloth && state.count >= TARGET_COUNT) {
    const lastItem = wardrobeBox.lastElementChild;
    if (lastItem && !lastItem.classList.contains('user-item')) {
      lastItem.style.transition = 'all 0.3s';
      lastItem.style.opacity = '0';
      lastItem.style.transform = 'scale(0.3)';
      setTimeout(() => lastItem.remove(), 300);
      state.count = TARGET_COUNT - 1;
    }
  }

  const item = document.createElement('div');
  item.className = 'cloth-item settled';
  if (cloth && cloth.imageUrl) {
    item.classList.add('user-item');
  }

  const type = CLOTH_TYPES[state.count % CLOTH_TYPES.length];
  const pos = POSITIONS[state.count % POSITIONS.length];
  const jitterX = (Math.random() - 0.5) * 4;
  const jitterY = (Math.random() - 0.5) * 4;

  item.style.left = `${parseFloat(pos.left) + jitterX}%`;
  item.style.top = `${parseFloat(pos.top) + jitterY}%`;
  item.style.transform = `rotate(${pos.rotate}deg)`;
  item.style.animationDelay = `0s`;
  item.style.zIndex = state.count + 1;

  // 사진이 있으면 사진, 없으면 이모지
  if (cloth && cloth.imageUrl) {
    const catEmoji = CATEGORIES[cloth.category]?.emoji || '👕';
    const catName = CATEGORIES[cloth.category]?.name || '옷';
    item.innerHTML = `
      <img src="${cloth.imageUrl}" class="cloth-photo" alt="${catName}">
      <div class="cloth-label">
        <span class="cat-mini-emoji">${catEmoji}</span>
        ${catName}
      </div>
    `;
  } else {
    item.innerHTML = `
      <div class="cloth-emoji">${type.emoji}</div>
      <div class="cloth-label">${type.label}</div>
    `;
  }
  wardrobeBox.appendChild(item);

  state.count++;
  updateProgress();

  if (state.count >= TARGET_COUNT && !cloth) {
    setTimeout(() => {
      document.getElementById('message').innerHTML = '🎉 <strong>5개 아이템</strong> 추가 완료!<br>스타일링을 시작해보세요';
      showStartButton();
      showToast('🎉 5개 완료! 스타일링을 시작해보세요');
    }, 600);
  } else if (cloth) {
    showToast(`✅ ${CATEGORIES[cloth.category]?.name || '옷'} 추가됨`);
    if (state.count >= TARGET_COUNT) {
      setTimeout(() => showStartButton(), 600);
    }
  } else {
    showToast(`옷 추가됨 (${state.count}/${TARGET_COUNT})`);
  }
}

function updateProgress() {
  const percent = (state.count / TARGET_COUNT) * 100;
  document.getElementById('progressFill').style.width = `${percent}%`;
  document.getElementById('progressText').textContent = `${state.count} / ${TARGET_COUNT}`;
}

function autoAddDemo() {
  demoInterval = setInterval(() => {
    if (state.count >= TARGET_COUNT) {
      clearInterval(demoInterval);
      return;
    }
    // 데모는 일러스트에만 추가 (옷장 그리드에는 X)
    addCloth();
  }, 800);
}

function reset() {
  state.count = 0;
  const wardrobeBox = document.getElementById('wardrobeBox');
  const wardrobeCard = document.getElementById('wardrobeCard');
  const emptyText = document.getElementById('emptyText');
  const message = document.getElementById('message');

  Array.from(wardrobeBox.children).forEach((child, i) => {
    setTimeout(() => {
      child.style.transition = 'all 0.3s';
      child.style.opacity = '0';
      child.style.transform = 'scale(0.3) translateY(-30px)';
      setTimeout(() => child.remove(), 300);
    }, i * 50);
  });

  setTimeout(() => {
    wardrobeCard.classList.add('empty');
    emptyText.style.display = 'block';
    message.innerHTML = '✨ 아이템 5개를 추가하고<br>나만의 맞춤 스타일링을 시작해 보세요';
    updateProgress();
  }, 600);

  showToast('초기화됨');
}

// ========================================
// 옷 추가 모달 (수동 카테고리 선택)
// ========================================
function setupAddBtn() {
  document.getElementById('addBtn').onclick = () => {
    openAddModal();
  };
}

function setupAddModal() {
  // 닫기 / 취소
  document.getElementById('closeAdd').onclick = closeAddModal;

  // 앨범 선택
  document.getElementById('albumBtn').onclick = () => {
    document.getElementById('photoInput').click();
  };

  // 파일 선택 완료
  document.getElementById('photoInput').onchange = (e) => {
    const file = e.target.files[0];
    if (file) handlePhotoSelect(file);
  };

  // 다시 찍기
  document.getElementById('retakeBtn').onclick = resetAddModalState;

  // 수동 카테고리 버튼
  document.querySelectorAll('.manual-cat-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.manual-cat-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      state.modal.selectedCategory = btn.dataset.cat;
      updateSaveButton();
    };
  });

  // UID 입력 → 저장 버튼 활성화
  document.getElementById('uidInput').oninput = updateSaveButton;

  // UID 스캔 (mock)
  document.getElementById('scanUidBtn').onclick = () => {
    const mockUid = generateMockUid();
    document.getElementById('uidInput').value = mockUid;
    showToast('📡 UID 스캔: ' + mockUid);
    updateSaveButton();
  };

  // 저장
  document.getElementById('saveBtn').onclick = saveNewCloth;

  // 드래그 앤 드롭
  const uploadPlaceholder = document.getElementById('uploadPlaceholder');
  uploadPlaceholder.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadPlaceholder.classList.add('dragover');
  });
  uploadPlaceholder.addEventListener('dragleave', () => {
    uploadPlaceholder.classList.remove('dragover');
  });
  uploadPlaceholder.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadPlaceholder.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      handlePhotoSelect(file);
    }
  });
}

function openAddModal() {
  resetAddModalState();
  document.getElementById('addModal').showModal();
}

function closeAddModal() {
  document.getElementById('addModal').close();
}

function resetAddModalState() {
  state.modal.photoDataUrl = null;
  state.modal.selectedCategory = null;

  document.getElementById('uploadPlaceholder').hidden = false;
  document.getElementById('previewArea').hidden = true;
  document.getElementById('categorySelector').hidden = true;
  document.getElementById('uidSection').hidden = true;
  document.getElementById('uidInput').value = '';
  document.getElementById('saveBtn').disabled = true;
  document.getElementById('photoInput').value = '';
  document.querySelectorAll('.manual-cat-btn').forEach(b => b.classList.remove('selected'));
}

function handlePhotoSelect(file) {
  const reader = new FileReader();
  reader.onload = (event) => {
    const dataUrl = event.target.result;
    state.modal.photoDataUrl = dataUrl;

    // 미리보기 표시
    document.getElementById('uploadPlaceholder').hidden = true;
    document.getElementById('previewArea').hidden = false;
    document.getElementById('previewImg').src = dataUrl;

    // 카테고리 선택 영역 + UID 영역 표시
    document.getElementById('categorySelector').hidden = false;
    document.getElementById('uidSection').hidden = false;

    updateSaveButton();
  };
  reader.readAsDataURL(file);
}

function updateSaveButton() {
  const uid = document.getElementById('uidInput').value.replace(/\s/g, '');
  const hasCategory = state.modal.selectedCategory !== null;
  const hasPhoto = state.modal.photoDataUrl !== null;
  document.getElementById('saveBtn').disabled = !(uid.length >= 7 && hasCategory && hasPhoto);
}

function saveNewCloth() {
  const uid = document.getElementById('uidInput').value.replace(/\s/g, '').toUpperCase();
  const cat = state.modal.selectedCategory;
  const catInfo = CATEGORIES[cat];

  const cloth = {
    uid,
    name: catInfo.name + ' ' + (state.clothes.length + 1),
    category: cat,
    season: 'allseason',
    imageUrl: state.modal.photoDataUrl,
    state: 'IN_WARDROBE',
    createdAt: Date.now(),
  };

  state.clothes.unshift(cloth);
  saveClothes();
  closeAddModal();

  // 홈 화면 일러스트에 추가
  addCloth(cloth);

  // 옷장 페이지 그리드 업데이트
  renderCloset();

  // 5개 도달 시 스타일링 시작 버튼 표시
  if (state.clothes.length >= 5) {
    setTimeout(() => showStartButton(), 400);
  }
}

function generateMockUid() {
  const chars = '0123456789ABCDEF';
  let uid = '';
  for (let i = 0; i < 14; i++) {
    uid += chars[Math.floor(Math.random() * 16)];
    if (i === 1 || i === 3 || i === 5 || i === 7 || i === 9 || i === 11) uid += ' ';
  }
  return uid.trim();
}

// ========================================
// 옷 목록 (옷장 페이지)
// ========================================
function loadClothes() {
  const data = localStorage.getItem('smartWardrobeClothes');
  state.clothes = data ? JSON.parse(data) : [];
}

function saveClothes() {
  localStorage.setItem('smartWardrobeClothes', JSON.stringify(state.clothes));
}

function renderClothes() {
  // 현재는 홈 화면에 일러스트만 표시. 옷장 페이지에서 그리드 표시 예정.
}

// ========================================
// 네비게이션
// ========================================
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.onclick = () => {
      const nav = btn.dataset.nav;
      switchView(nav);
    };
  });
}

function switchView(view) {
  state.currentView = view;

  // nav active
  document.querySelectorAll('.nav-item').forEach(b => {
    b.classList.toggle('active', b.dataset.nav === view);
  });

  // 페이지 전환
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(`page-${view}`);
  if (page) {
    page.classList.add('active');
  }

  // 페이지별 초기화
  if (view === 'closet') {
    renderCloset();
  }
}

// ========================================
// 스타일링 시작 → 옷장 페이지로
// ========================================
function setupStartButton() {
  const startBtn = document.getElementById('startBtn');
  const closetStartBtn = document.getElementById('closetStartBtn');

  const onStart = () => {
    if (demoInterval) {
      clearInterval(demoInterval);
      demoInterval = null;
    }
    state.started = true;
    switchView('outfit');
    showToast('🎉 스타일링 시작!');
  };

  if (startBtn) startBtn.onclick = onStart;
  if (closetStartBtn) closetStartBtn.onclick = onStart;
}

function showStartButton() {
  const closetStartWrap = document.getElementById('closetStartWrap');
  if (closetStartWrap) closetStartWrap.hidden = false;
}

// ========================================
// 옷장 페이지 렌더링
// ========================================
function renderCloset() {
  const grid = document.getElementById('closetGrid');
  let list = [...state.clothes];

  if (state.sort === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  if (list.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 60px 20px; color: #8e8e93;">
        <div style="font-size: 64px; margin-bottom: 12px; opacity: 0.4;">👔</div>
        <p>아직 등록된 옷이 없어요</p>
        <p style="font-size: 13px; margin-top: 4px;">"아이템 가져오기"로 추가해보세요</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = list.map(cloth => {
    const catName = CATEGORIES[cloth.category]?.name || '옷';
    const date = cloth.createdAt ? new Date(cloth.createdAt).toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
    }).replace(/\. /g, '.').replace(/\.$/, '') : '';

    const imgHtml = cloth.imageUrl
      ? `<img src="${cloth.imageUrl}" class="closet-item-img" alt="${catName}">`
      : `<div class="closet-item-noimg">${CATEGORIES[cloth.category]?.emoji || '👕'}</div>`;

    return `
      <div class="closet-item">
        ${imgHtml}
        <div class="closet-item-info">
          <div class="closet-item-brand">${catName}</div>
          <div class="closet-item-date">${date}</div>
        </div>
      </div>
    `;
  }).join('');
}

function setupClosetTabs() {
  document.querySelectorAll('.closet-tab').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.closet-tab').forEach(t => t.classList.toggle('active', t === tab));
      // 탭별 동작 (데모에서는 토스트만)
      const labels = { all: '아이템 가져오기', stats: '스타일 통계', wishlist: '위시리스트', beautify: '뷰티파이', share: '옷장 공유' };
      showToast(`${labels[tab.dataset.tab]} (데모)`);
    };
  });

  // 첫 탭("아이템 가져오기")은 모달 열기
  document.querySelector('.closet-tab[data-tab="all"]').onclick = () => {
    document.querySelectorAll('.closet-tab').forEach(t => t.classList.toggle('active', t === tab));
    openAddModal();
  };
}

function setupClosetSort() {
  document.querySelectorAll('.sort-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b === btn));
      state.sort = btn.dataset.sort;
      renderCloset();
    };
  });
}

// ========================================
// Toast
// ========================================
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => el.classList.remove('show'), 2000);
}

// 시작
init();
