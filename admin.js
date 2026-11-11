/* Pemilwa KMTEDI / panel admin. Semua aksi lewat /api/admin dengan token sesi. */
(() => {
'use strict';

const $ = id => document.getElementById(id);
const SESSION_KEY = 'kmtedi_admin_session';
let sessionToken = sessionStorage.getItem(SESSION_KEY) || '';
let loadedCandidates = [];

function show(id, visible) { $(id).classList.toggle('hidden', !visible); }

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function safeImage(url, fallback) {
  const u = String(url || '');
  return /^(data:image\/(png|jpeg|webp);base64,|https:\/\/|assets\/)/.test(u) ? u : fallback;
}

async function api(action, payload = {}) {
  const res = await fetch('/api/admin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {})
    },
    body: JSON.stringify({ action, ...payload })
  });
  let data = {};
  try { data = await res.json(); } catch { data = {}; }
  if (res.status === 401 && action !== 'login') {
    logout();
    throw new Error(data.error || 'Sesi admin berakhir. Silakan login ulang.');
  }
  if (!res.ok || !data.success) throw new Error(data.error || 'Permintaan gagal.');
  return data;
}

// TABS
document.querySelectorAll('.admin-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));
    tab.classList.add('active');
    show(tab.dataset.tab, true);
  };
});

// CLIENT-SIDE IMAGE COMPRESSION (max 800x1000px, JPEG quality 0.85)
function compressImage(file, callback) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
    alert('Format gambar harus PNG, JPG, atau WEBP.');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      let w = img.width, h = img.height;
      const maxW = 800, maxH = 1000;
      if (w > maxW || h > maxH) {
        if (w / h > maxW / maxH) {
          h = Math.round(h * maxW / w);
          w = maxW;
        } else {
          w = Math.round(w * maxH / h);
          h = maxH;
        }
      }
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      callback(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

$('candPhotoFileInput').onchange = e => {
  const file = e.target.files[0];
  if (!file) return;
  $('photoFileName').textContent = file.name;
  compressImage(file, dataUrl => {
    $('candPhotoPreview').src = dataUrl;
    $('candPhoto').value = dataUrl;
  });
};

$('candPhoto').oninput = () => {
  const val = $('candPhoto').value.trim();
  if (val) $('candPhotoPreview').src = safeImage(val, 'assets/ig-panel-1.jpg');
};

for (let i = 0; i < 3; i++) {
  $(`heroUploadBtn${i}`).onclick = () => $(`heroFile${i}`).click();
  $(`heroFile${i}`).onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    compressImage(file, dataUrl => {
      $(`heroPreview${i}`).src = dataUrl;
      $(`heroImage${i}`).value = dataUrl;
    });
  };
}
$('candPhotoUploadBtn').onclick = () => $('candPhotoFileInput').click();

// LOGIN
async function enterDashboard() {
  show('loginSection', false);
  show('dashboardSection', true);
  show('logout', true);
  await refreshDashboard();
}

function logout() {
  sessionToken = '';
  sessionStorage.removeItem(SESSION_KEY);
  show('dashboardSection', false);
  show('logout', false);
  show('loginSection', true);
}

$('loginForm').onsubmit = async e => {
  e.preventDefault();
  $('loginErr').textContent = 'Memverifikasi PIN...';
  try {
    const { token } = await api('login', { pin: $('pinInput').value });
    sessionToken = token;
    sessionStorage.setItem(SESSION_KEY, token);
    $('pinInput').value = '';
    $('loginErr').textContent = '';
    await enterDashboard();
  } catch (err) {
    $('loginErr').textContent = err.message;
  }
};

$('logout').onclick = logout;

function toLocalDatetimeInput(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function refreshDashboard() {
  let dash;
  try {
    ({ dashboard: dash } = await api('dashboard'));
  } catch (err) {
    console.error('Error loading dashboard:', err);
    return;
  }
  const s = dash.settings || {};

  $('voterCount').textContent = dash.voted_count ?? 0;
  $('votingStatusBadge').textContent = dash.voting_open_now ? 'TERBUKA' : 'DITUTUP';
  $('votingStatusBadge').style.color = dash.voting_open_now ? 'var(--gold)' : 'var(--red)';
  $('votingStateText').textContent = s.voting_open ? 'Bilik Suara: SAKLAR DIBUKA' : 'Bilik Suara: SAKLAR DITUTUP';
  $('votingStateDesc').textContent = dash.voting_open_now
    ? 'Mahasiswa dapat memberikan suara saat ini.'
    : (s.voting_open ? 'Saklar dibuka, tetapi di luar jadwal yang disetel.' : 'Voting dikunci, mahasiswa belum bisa memilih.');
  $('toggleVotingBtn').textContent = s.voting_open ? 'Kunci / Tutup Voting' : 'Buka Bilik Suara';
  $('toggleResultsBtn').textContent = s.results_published ? 'Sembunyikan Hasil dari Publik' : 'Buka Hasil ke Publik';

  if (s.voting_start) {
    $('inputVotingStart').value = toLocalDatetimeInput(s.voting_start);
    const d = new Date(s.voting_start);
    $('scheduleStatusText').textContent = new Date() < d
      ? `Countdown aktif: menuju pembukaan pada ${d.toLocaleString('id-ID')} WIB`
      : `Waktu pembukaan telah tercapai (${d.toLocaleString('id-ID')} WIB).`;
  } else {
    $('inputVotingStart').value = '';
    $('scheduleStatusText').textContent = 'Mode manual: bilik suara dikontrol langsung lewat tombol Buka/Tutup di atas.';
  }
  $('inputVotingEnd').value = toLocalDatetimeInput(s.voting_end);

  // Panels
  const slides = s.hero_slides || [];
  for (let i = 0; i < 3; i++) {
    const item = slides[i] || {};
    const fallback = `assets/ig-panel-${i + 1}.jpg`;
    $(`heroImage${i}`).value = item.image || fallback;
    $(`heroCaption${i}`).value = String(item.caption || '').replace(/<br\s*\/?>/gi, '\n');
    $(`heroPreview${i}`).src = safeImage(item.image, fallback);
  }
  $('panelMarquee').value = s.marquee_text || '';
  $('panelAboutStatement').value = s.about_statement || '';
  $('panelAboutInfo').value = s.about_info || '';
  const timeline = s.timeline_items || [];
  for (let i = 0; i < 4; i++) {
    const t = timeline[i] || {};
    $(`timeTitle${i}`).value = t.title || '';
    $(`timeDesc${i}`).value = t.desc || '';
    $(`timeDate${i}`).value = t.date || '';
  }

  // Results (hidden by the server while voting is open)
  if (dash.results === null) {
    $('voteCount').textContent = dash.voted_count ?? 0;
    $('resultsList').innerHTML = '<div class="notice">Rekap per calon disembunyikan selama bilik suara terbuka untuk menjaga kerahasiaan suara. Tutup bilik suara untuk melihat hasil.</div>';
  } else {
    const results = dash.results || [];
    const totalVotes = results.reduce((acc, r) => acc + Number(r.vote_count), 0);
    $('voteCount').textContent = totalVotes;
    $('resultsList').innerHTML = results.length ? results.map(r => {
      const pct = totalVotes > 0 ? Math.round((Number(r.vote_count) / totalVotes) * 100) : 0;
      return `
        <div class="row">
          <div>
            <b style="font-size:16px">${Number(r.order_number)}. ${escapeHtml(r.candidate_name)}</b><br>
            <small>${pct}% dari total suara masuk</small>
          </div>
          <div style="text-align:right">
            <strong style="font-size:24px;font-family:Anton;color:var(--gold)">${Number(r.vote_count)}</strong>
            <small style="display:block">suara</small>
          </div>
        </div>`;
    }).join('') : '<div class="notice">Belum ada data calon atau suara masuk.</div>';
  }

  const voters = dash.voters || [];
  $('votersList').innerHTML = voters.length ? `
    <div style="max-height:260px;overflow-y:auto">
      ${voters.map((v, i) => `
        <div class="row" style="padding:10px 0">
          <div>
            <b style="font-size:14px;color:var(--cream)">${i + 1}. NIM: ${escapeHtml(v.nim)}</b><br>
            <small style="color:var(--gold)">Email UGM: ${escapeHtml(v.email || '-')}</small>
          </div>
          <small style="color:var(--muted)">${escapeHtml(new Date(v.voted_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }))} WIB</small>
        </div>`).join('')}
    </div>` : '<div class="notice">Belum ada mahasiswa yang memilih.</div>';

  loadedCandidates = dash.candidates || [];
  if (loadedCandidates.length) {
    $('candidatesList').innerHTML = loadedCandidates.map(c => `
      <div class="candidate-item">
        <img src="${escapeHtml(safeImage(c.photo_url, 'assets/ig-panel-1.jpg'))}" class="candidate-thumb" alt="${escapeHtml(c.name)}">
        <div>
          <b style="font-size:16px;color:var(--gold)">${Number(c.order_number)}. ${escapeHtml(c.name)}</b>
          <span style="font-size:11px;font-family:'Space Mono';color:var(--muted);margin-left:8px">(${c.batch ? 'Angkatan ' + escapeHtml(c.batch) : 'Angkatan belum diisi'} / NIM: ${escapeHtml(c.nim || '-')})</span>
          <p style="margin:4px 0 0;font-size:13px;color:var(--cream);opacity:.85">${escapeHtml(c.vision || 'Visi belum diisi.')}</p>
          <small style="color:${c.is_active ? 'var(--gold)' : 'var(--red)'}">${c.is_active ? 'AKTIF DI BILIK' : 'NONAKTIF'}</small>
        </div>
        <button class="btn alt edit-cand-btn" data-id="${escapeHtml(c.id)}" style="padding:8px 14px;font-size:10px">Edit Biodata</button>
      </div>`).join('');
    document.querySelectorAll('.edit-cand-btn').forEach(btn => {
      btn.addEventListener('click', () => openCandidateModal(btn.dataset.id));
    });
  } else {
    $('candidatesList').innerHTML = '<div class="notice">Belum ada calon terdaftar. Klik "+ Tambah Calon Baru" di atas.</div>';
  }
}

// SAVE HOMEPAGE PANELS
async function saveAllPanels() {
  const heroSlides = [];
  for (let i = 0; i < 3; i++) {
    heroSlides.push({
      image: $(`heroImage${i}`).value.trim() || `assets/ig-panel-${i + 1}.jpg`,
      caption: $(`heroCaption${i}`).value.trim().replace(/\n/g, '<br>')
    });
  }
  const timelineItems = [];
  for (let i = 0; i < 4; i++) {
    timelineItems.push({
      title: $(`timeTitle${i}`).value.trim(),
      desc: $(`timeDesc${i}`).value.trim(),
      date: $(`timeDate${i}`).value.trim()
    });
  }
  try {
    await api('save_panels', {
      hero_slides: heroSlides,
      marquee_text: $('panelMarquee').value.trim(),
      about_statement: $('panelAboutStatement').value.trim(),
      about_info: $('panelAboutInfo').value.trim(),
      timeline_items: timelineItems
    });
    alert('Pengaturan panel beranda berhasil disimpan dan langsung aktif di web publik.');
    await refreshDashboard();
  } catch (err) {
    alert(err.message);
  }
}

$('savePanelsBtn').onclick = saveAllPanels;
$('savePanelsBtn2').onclick = saveAllPanels;

// MODAL CANDIDATE EDITOR
const candModal = $('candidateModal');
function openCandidateModal(id) {
  $('candidateFormErr').textContent = '';
  $('photoFileName').textContent = '';
  if (id) {
    const c = loadedCandidates.find(item => item.id === id);
    if (!c) return;
    $('modalModeLabel').textContent = 'EDIT BIODATA CALON';
    $('modalCandidateTitle').textContent = `Calon No. ${c.order_number}`;
    $('candId').value = c.id;
    $('candOrder').value = c.order_number;
    $('candName').value = c.name;
    $('candBatch').value = c.batch || '';
    $('candNim').value = c.nim || '';
    $('candPhoto').value = c.photo_url || '';
    $('candPhotoPreview').src = safeImage(c.photo_url, 'assets/ig-panel-1.jpg');
    $('candHistory').value = c.organization_history || '';
    $('candVision').value = c.vision || '';
    $('candMission').value = (c.mission || []).join('\n');
    $('candPrograms').value = (c.programs || []).join('\n');
    $('candActive').checked = c.is_active ?? true;
    show('deleteCandBtn', true);
  } else {
    const fallback = `assets/ig-panel-${(loadedCandidates.length % 6) + 1}.jpg`;
    $('modalModeLabel').textContent = 'TAMBAH CALON BARU';
    $('modalCandidateTitle').textContent = 'Paslon Baru';
    $('candId').value = '';
    $('candOrder').value = loadedCandidates.length + 1;
    $('candName').value = '';
    $('candBatch').value = '2023';
    $('candNim').value = '';
    $('candPhoto').value = fallback;
    $('candPhotoPreview').src = fallback;
    $('candHistory').value = '';
    $('candVision').value = '';
    $('candMission').value = '';
    $('candPrograms').value = '';
    $('candActive').checked = true;
    show('deleteCandBtn', false);
  }
  candModal.classList.add('open');
}

function closeCandidateModal() { candModal.classList.remove('open'); }

$('addCandidateBtn').onclick = () => openCandidateModal(null);
$('candidateModalClose').onclick = closeCandidateModal;
$('cancelCandBtn').onclick = closeCandidateModal;
candModal.onclick = e => { if (e.target === candModal) closeCandidateModal(); };

$('candidateForm').onsubmit = async e => {
  e.preventDefault();
  $('candidateFormErr').textContent = 'Menyimpan data paslon...';
  try {
    await api('save_candidate', {
      candidate: {
        id: $('candId').value || null,
        order_number: $('candOrder').value,
        name: $('candName').value,
        batch: $('candBatch').value,
        nim: $('candNim').value,
        photo_url: $('candPhoto').value,
        organization_history: $('candHistory').value,
        vision: $('candVision').value,
        mission: $('candMission').value.split('\n'),
        programs: $('candPrograms').value.split('\n'),
        is_active: $('candActive').checked
      }
    });
    closeCandidateModal();
    alert('Data paslon berhasil disimpan.');
    await refreshDashboard();
  } catch (err) {
    $('candidateFormErr').textContent = err.message;
  }
};

$('deleteCandBtn').onclick = async () => {
  const id = $('candId').value;
  if (!id) return;
  if (!confirm('Yakin ingin menghapus calon ini dari daftar pemilwa?')) return;
  try {
    await api('delete_candidate', { id });
    closeCandidateModal();
    alert('Calon berhasil dihapus.');
    await refreshDashboard();
  } catch (err) {
    alert(err.message);
  }
};

async function runAction(action, payload, successMsg) {
  try {
    await api(action, payload);
    if (successMsg) alert(successMsg);
    await refreshDashboard();
  } catch (err) {
    alert(err.message);
  }
}

$('toggleVotingBtn').onclick = () => {
  if (!confirm('Ubah status buka/tutup bilik suara sekarang?')) return;
  runAction('toggle', { field: 'voting_open' });
};

$('toggleResultsBtn').onclick = () => {
  if (!confirm('Ubah status visibilitas hasil suara publik?')) return;
  runAction('toggle', { field: 'results_published' });
};

$('resetVotesBtn').onclick = () => {
  const typed = prompt('PERHATIAN: seluruh kotak suara dan daftar hadir pemilih akan dikosongkan. Bilik suara harus ditutup dulu.\n\nKetik RESET untuk melanjutkan.');
  if (typed !== 'RESET') return;
  runAction('reset', { confirm: 'RESET' }, 'Kotak suara berhasil dikosongkan.');
};

$('saveScheduleBtn').onclick = () => {
  const startVal = $('inputVotingStart').value;
  const endVal = $('inputVotingEnd').value;
  $('scheduleStatusText').textContent = 'Menyimpan jadwal...';
  runAction('schedule', {
    start: startVal ? new Date(startVal).toISOString() : null,
    end: endVal ? new Date(endVal).toISOString() : null
  }, 'Jadwal countdown berhasil disimpan.');
};

$('clearScheduleBtn').onclick = () => {
  if (!confirm('Hapus jadwal countdown dan kembali ke mode manual?')) return;
  runAction('schedule', { start: null, end: null }, 'Jadwal berhasil dihapus.');
};

if (sessionToken) enterDashboard();
})();
