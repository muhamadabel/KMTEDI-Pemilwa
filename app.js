/* Pemilwa KMTEDI 2026 / logika halaman publik.
   Semua script ada di file ini (tanpa inline script) agar CSP bisa ketat. */
(() => {
'use strict';

const $ = id => document.getElementById(id);
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
document.documentElement.classList.add('js');

// SAFE RENDERING HELPERS: semua data dari database wajib lewat sini sebelum masuk innerHTML
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
// Escape lalu izinkan hanya patah baris (<br> atau newline)
function richText(value) {
  return escapeHtml(value).replace(/&lt;br\s*\/?&gt;/gi, '<br>').replace(/\n/g, '<br>');
}
function safeImage(url, fallback) {
  const u = String(url || '');
  return /^(data:image\/(png|jpeg|webp);base64,|https:\/\/|assets\/)/.test(u) ? u : fallback;
}
const PLACEHOLDER = 'assets/candidate-placeholder.svg';
const pad2 = n => String(Math.max(0, Math.floor(n))).padStart(2, '0');

// TOPBAR: latar blur setelah halaman digulir
const topbar = $('topbar');
const onScroll = () => topbar.classList.toggle('scrolled', window.scrollY > 24);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// REVEAL ON SCROLL + GARIS MELIUK
const revealTargets = document.querySelectorAll('.reveal, .ticket-stage, .squiggle');
if ('IntersectionObserver' in window && !reduceMotion) {
  const io = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add(entry.target.classList.contains('squiggle') ? 'drawn' : 'in');
      io.unobserve(entry.target);
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  revealTargets.forEach(el => io.observe(el));
} else {
  revealTargets.forEach(el => el.classList.add(el.classList.contains('squiggle') ? 'drawn' : 'in'));
}

// HERO CAROUSEL (kartu lanyard)
const heroSlides = [
  ['assets/ig-panel-1.jpg', 'Ruang untuk<br>gagasan baru.'],
  ['assets/ig-panel-2.jpg', 'Kampus yang<br>ikut bergerak.'],
  ['assets/ig-panel-6.jpg', 'Pilih dengan<br>kesadaran.']
];
let heroIndex = 0;
const heroCard = $('heroCard');
const heroImg = $('heroImg');
const heroCaption = $('heroCaption');
const heroNumber = $('heroIndex');
const heroDots = [...document.querySelectorAll('.hero-dot')];

function setHero(i) {
  heroIndex = (i + heroSlides.length) % heroSlides.length;
  if (!heroCard) return;
  heroCard.classList.add('changing');
  setTimeout(() => {
    heroImg.src = safeImage(heroSlides[heroIndex][0], 'assets/ig-panel-1.jpg');
    heroCaption.innerHTML = richText(heroSlides[heroIndex][1]);
    heroNumber.textContent = `${pad2(heroIndex + 1)} / ${pad2(heroSlides.length)}`;
    heroDots.forEach((d, n) => d.classList.toggle('active', n === heroIndex));
    heroCard.classList.remove('changing');
  }, 260);
}

let heroTimer = null;
function resetHeroTimer() {
  if (heroTimer) clearInterval(heroTimer);
  if (!reduceMotion) heroTimer = setInterval(() => setHero(heroIndex + 1), 6000);
}
resetHeroTimer();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInterval(heroTimer); else resetHeroTimer();
});

heroDots.forEach((d, i) => d.addEventListener('click', () => {
  setHero(i);
  resetHeroTimer();
}));

// HERO CARD SWIPE LANGSUNG DARI KARTU (TOUCH & MOUSE DRAG)
if (heroCard) {
  let touchStartX = 0;
  let touchStartY = 0;
  const swipe = (dx, dy) => {
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 25) {
      setHero(heroIndex + (dx < 0 ? 1 : -1));
      resetHeroTimer();
    }
  };

  heroCard.addEventListener('touchstart', e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  heroCard.addEventListener('touchend', e => {
    swipe(e.changedTouches[0].clientX - touchStartX, e.changedTouches[0].clientY - touchStartY);
  }, { passive: true });

  let mouseStartX = 0;
  let mouseStartY = 0;
  let dragging = false;
  heroCard.addEventListener('mousedown', e => {
    dragging = true;
    mouseStartX = e.clientX;
    mouseStartY = e.clientY;
  });
  window.addEventListener('mouseup', e => {
    if (!dragging) return;
    dragging = false;
    swipe(e.clientX - mouseStartX, e.clientY - mouseStartY);
  });
}

// DATA CALON (fallback sebelum data database termuat)
let candidates = [
  ['Calon Satu', PLACEHOLDER, null, 1, 'KANDIDAT 01', 'Visi kandidat akan diumumkan panitia.', ['Misi kandidat akan diumumkan panitia.'], ['Program kerja akan diumumkan panitia.'], 'Riwayat organisasi belum diisi oleh panitia.'],
  ['Calon Dua', PLACEHOLDER, null, 2, 'KANDIDAT 02', 'Visi kandidat akan diumumkan panitia.', ['Misi kandidat akan diumumkan panitia.'], ['Program kerja akan diumumkan panitia.'], 'Riwayat organisasi belum diisi oleh panitia.'],
  ['Calon Tiga', PLACEHOLDER, null, 3, 'KANDIDAT 03', 'Visi kandidat akan diumumkan panitia.', ['Misi kandidat akan diumumkan panitia.'], ['Program kerja akan diumumkan panitia.'], 'Riwayat organisasi belum diisi oleh panitia.']
];

let selected = 0;
let slide = 0;
let candidateToVote = null;
let pendingVoteIndex = null;
let electionSettings = null;
let hasVoted = false;
let pendingVoterData = { nim: '', email: '' };

const cfg = window.KMTEDI_SUPABASE_CONFIG || {};

// Baca data publik (read-only) langsung dari Supabase REST dengan publishable key.
async function restSelect(path) {
  const res = await fetch(`${cfg.url}/rest/v1/${path}`, { headers: { apikey: cfg.anonKey } });
  if (!res.ok) throw new Error(`Gagal memuat ${path.split('?')[0]}`);
  return res.json();
}

const voterModal = $('voterModal');
const profileModal = $('profileModal');
const confirmVoteModal = $('confirmVoteModal');
const successModal = $('successModal');
const noticeModal = $('noticeModal');

// MODAL HELPERS
let lastFocus = null;
function openModal(modal, focusEl) {
  lastFocus = document.activeElement;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  setTimeout(() => (focusEl || modal.querySelector('.modal-close, button'))?.focus({ preventScroll: true }), 60);
}
function closeModal(modal) {
  if (!modal.classList.contains('open')) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  if (!document.querySelector('.modal-backdrop.open')) document.body.style.overflow = '';
  if (lastFocus && document.contains(lastFocus)) lastFocus.focus({ preventScroll: true });
}

// Token surat suara sekali pakai dari /api/verify-otp. NIM dan email hanya
// untuk tampilan; server tidak mempercayai nilai ini.
function getVoter() {
  const nim = (sessionStorage.getItem('kmtedi_voter_nim') || '').trim().toUpperCase();
  const email = (sessionStorage.getItem('kmtedi_voter_email') || '').trim().toLowerCase();
  const token = sessionStorage.getItem('kmtedi_ballot_token') || '';
  const voted = sessionStorage.getItem('kmtedi_has_voted') === 'true';
  return { nim, email, token, hasVoted: voted };
}

function updateVoterUI() {
  const v = getVoter();
  const container = $('userStatusWrapper');
  const mainBtn = $('mainVoteBtn');
  const copyText = $('voteCopyText');
  const heroBtn = $('heroVoteBtn');

  if (v.nim && v.email && (v.token || v.hasVoted)) {
    hasVoted = v.hasVoted;
    container.innerHTML = `
      <div class="user-pill">
        <span class="user-greeting">NIM: <b>${escapeHtml(v.nim)}</b></span>
        <span class="user-badge ${hasVoted ? 'voted' : 'ready'}">${hasVoted ? 'Sudah Memilih' : 'Siap Memilih'}</span>
        <button type="button" class="btn-change-voter" data-action="clear-voter" title="Ganti identitas pemilih">Ganti</button>
      </div>`;

    if (hasVoted) {
      copyText.innerHTML = `NIM <b>${escapeHtml(v.nim)}</b> (${escapeHtml(v.email)}): hak suara Anda <b>sudah sah tercatat</b> dalam Pemilwa KMTEDI 2026. Terima kasih atas partisipasi Anda.`;
      mainBtn.textContent = 'Sudah Memilih';
      mainBtn.disabled = true;
      if (heroBtn) heroBtn.textContent = 'Sudah Memilih';
    } else {
      copyText.innerHTML = `Terverifikasi: NIM <b>${escapeHtml(v.nim)}</b> (${escapeHtml(v.email)}). Silakan tentukan calon ketua pilihan Anda.`;
      mainBtn.textContent = 'Pilih Calon Sekarang';
      mainBtn.disabled = false;
      if (heroBtn) heroBtn.textContent = 'Lihat Calon & Pilih';
    }
  } else {
    hasVoted = false;
    container.innerHTML = '<button type="button" class="btn-nav-verify" data-action="open-voter">Verifikasi Pemilih (NIM)</button>';
    copyText.textContent = 'Verifikasi hak suara Anda melalui email UGM untuk mengaktifkan bilik suara dan memberikan suara sah.';
    mainBtn.textContent = 'Verifikasi Pemilih (NIM & Email UGM)';
    mainBtn.disabled = false;
    if (heroBtn) heroBtn.textContent = 'Lihat Calon & Pilih';
  }

  renderCandidateCards();
}

function clearVoterSession() {
  ['kmtedi_voter_nim', 'kmtedi_voter_email', 'kmtedi_has_voted', 'kmtedi_ballot_token'].forEach(k => sessionStorage.removeItem(k));
  hasVoted = false;
  updateVoterUI();
}

// RENDER KARTU CALON: hanya bisa memilih sekali, klik kartu membuka profil
function renderCandidateCards() {
  for (let i = 0; i < 3; i++) {
    const card = $(`candCard${i}`);
    const c = candidates[i];
    if (!card) continue;
    const dot = document.querySelector(`.cand-dot[data-cand="${i}"]`);
    if (!c) {
      card.style.display = 'none';
      if (dot) dot.style.display = 'none';
      continue;
    }
    card.style.display = '';
    if (dot) dot.style.display = '';
    const no = pad2(c[3] || i + 1);
    const img = card.querySelector('.candidate-image img');
    img.src = safeImage(c[1], PLACEHOLDER);
    img.alt = `Foto ${c[0]}`;
    card.setAttribute('aria-label', `Profil calon nomor ${no}, ${c[0]}`);
    card.querySelector('.candidate-no').textContent = no;
    card.querySelector('.candidate-name').textContent = c[0];
    card.querySelector('.candidate-tag').textContent = c[4] || `KANDIDAT ${no}`;

    const voteBtn = $(`voteBtn${i}`);
    if (voteBtn) {
      voteBtn.textContent = hasVoted ? 'Sudah Memilih' : `Pilih ${no}`;
      voteBtn.disabled = hasVoted;
    }
  }
}

function isVotingActive() {
  if (!electionSettings || !electionSettings.voting_open) return false;
  const now = new Date();
  const startTime = electionSettings.voting_start ? new Date(electionSettings.voting_start) : null;
  const endTime = electionSettings.voting_end ? new Date(electionSettings.voting_end) : null;
  if (startTime && now < startTime) return false;
  if (endTime && now > endTime) return false;
  return true;
}

// STATUS BILIK SUARA: countdown diperbarui di tempat agar animasi tick halus
function setStatusMode(main, mode, html) {
  if (main.dataset.mode === mode) return false;
  main.dataset.mode = mode;
  main.innerHTML = html;
  return true;
}

function updateVotingStatus() {
  const label = $('votingStatusLabel');
  const main = $('votingStatusMain');
  const note = $('votingStatusNote');
  if (!label || !main || !note) return;

  const now = new Date();
  const startTime = electionSettings?.voting_start ? new Date(electionSettings.voting_start) : null;
  const endTime = electionSettings?.voting_end ? new Date(electionSettings.voting_end) : null;

  if (endTime && now > endTime) {
    label.textContent = 'STATUS BILIK SUARA';
    setStatusMode(main, 'closed', '<strong id="votingStatusBigText" class="status-big is-closed">Voting<br>Selesai</strong>');
    note.textContent = 'Waktu pemilihan telah berakhir. Menunggu pengumuman rekapitulasi resmi panitia.';
    return;
  }

  if (isVotingActive()) {
    label.textContent = 'STATUS BILIK SUARA';
    setStatusMode(main, 'open', '<strong id="votingStatusBigText" class="status-big is-open"><span class="live-dot" aria-hidden="true"></span>Voting<br>Terbuka</strong>');
    if (endTime) {
      const diff = endTime - now;
      note.textContent = `Bilik suara sedang dibuka. Ditutup dalam ${Math.floor(diff / 3600000)} jam ${pad2((diff / 60000) % 60)} menit ${pad2((diff / 1000) % 60)} detik.`;
    } else {
      note.textContent = 'Bilik suara sedang dibuka. Mahasiswa dapat memberikan suara sekarang.';
    }
    return;
  }

  if (electionSettings && !electionSettings.voting_open && (!startTime || now >= startTime)) {
    label.textContent = 'STATUS BILIK SUARA';
    setStatusMode(main, 'paused', '<strong id="votingStatusBigText" class="status-big is-closed">Bilik<br>Ditutup</strong>');
    note.textContent = 'Bilik suara sedang ditutup oleh panitia. Pantau pengumuman resmi untuk jadwal pembukaan.';
    return;
  }

  // Countdown menuju pembukaan (default: besok jika jadwal belum disetel)
  const targetTime = startTime || new Date(Date.now() + 24 * 3600 * 1000);
  const diff = Math.max(0, targetTime - now);
  const values = [diff / 86400000, (diff / 3600000) % 24, (diff / 60000) % 60, (diff / 1000) % 60].map(pad2);

  label.textContent = 'MENUJU BILIK SUARA DIBUKA';
  if (!main.querySelector('.countdown-grid') || main.dataset.mode !== 'countdown') {
    main.dataset.mode = 'countdown';
    main.innerHTML = `
      <div class="countdown-grid">
        <div class="countdown-item"><span class="countdown-num">00</span><span class="countdown-tag">HARI</span></div>
        <span class="countdown-sep">:</span>
        <div class="countdown-item"><span class="countdown-num">00</span><span class="countdown-tag">JAM</span></div>
        <span class="countdown-sep">:</span>
        <div class="countdown-item"><span class="countdown-num">00</span><span class="countdown-tag">MENIT</span></div>
        <span class="countdown-sep">:</span>
        <div class="countdown-item"><span class="countdown-num">00</span><span class="countdown-tag">DETIK</span></div>
      </div>`;
  }
  main.querySelectorAll('.countdown-num').forEach((el, i) => {
    if (el.textContent === values[i]) return;
    el.textContent = values[i];
    if (!reduceMotion) {
      el.classList.remove('tick');
      void el.offsetWidth;
      el.classList.add('tick');
    }
  });

  if (startTime) {
    const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    note.textContent = `Bilik suara dibuka resmi pada ${startTime.toLocaleDateString('id-ID', opts)} WIB.`;
  } else {
    note.textContent = 'Jadwal resmi pembukaan bilik suara akan diumumkan panitia.';
  }
}

setInterval(updateVotingStatus, 1000);

// TIKET JADWAL di section Info
function updateTicket() {
  const dateEl = $('ticketDate');
  const timeEl = $('ticketTime');
  if (!dateEl || !timeEl || !electionSettings) return;
  const start = electionSettings.voting_start ? new Date(electionSettings.voting_start) : null;
  const end = electionSettings.voting_end ? new Date(electionSettings.voting_end) : null;
  if (!start) {
    dateEl.textContent = 'Diumumkan panitia';
    timeEl.textContent = 'Menyusul';
    return;
  }
  const dateOpts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' };
  const timeOpts = { hour: '2-digit', minute: '2-digit' };
  const sameDay = end && start.toDateString() === end.toDateString();
  dateEl.textContent = (!end || sameDay)
    ? start.toLocaleDateString('id-ID', dateOpts)
    : `${start.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })} s.d. ${end.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  timeEl.textContent = end
    ? `${start.toLocaleTimeString('id-ID', timeOpts)} - ${end.toLocaleTimeString('id-ID', timeOpts)} WIB`
    : `${start.toLocaleTimeString('id-ID', timeOpts)} WIB - selesai`;
}

function timelineState(status) {
  const s = String(status || '').toUpperCase();
  if (/BERJALAN|SEDANG|DIBUKA|BUKA/.test(s)) return 'is-active';
  if (/SELESAI|DONE|TUTUP/.test(s)) return 'is-done';
  return '';
}

function renderTimelineStates() {
  document.querySelectorAll('.time-row').forEach(row => {
    const state = timelineState(row.querySelector('.time-date')?.textContent);
    row.classList.remove('is-active', 'is-done');
    if (state) row.classList.add(state);
  });
}

async function loadPublicData() {
  if (!cfg.url || !cfg.anonKey) return;
  try {
    const [settingsRows, rows] = await Promise.all([
      restSelect('election_settings?select=voting_open,voting_start,voting_end,results_published,hero_slides,marquee_text,about_statement,about_info,timeline_items&limit=1'),
      restSelect('candidates?select=id,order_number,name,batch,photo_url,vision,mission,programs,organization_history&is_active=eq.true&order=order_number')
    ]);
    const settings = settingsRows && settingsRows[0];

    if (settings) {
      electionSettings = settings;
      updateVotingStatus();
      updateTicket();

      if (Array.isArray(settings.hero_slides) && settings.hero_slides.length) {
        heroSlides.length = 0;
        settings.hero_slides.forEach(s => heroSlides.push([s.image, s.caption]));
        setHero(0);
      }

      const mq = document.querySelector('.marquee-track');
      if (mq && settings.marquee_text) {
        const text = settings.marquee_text.trim();
        mq.textContent = `${text}   ${text}   ${text}   ${text}   `;
      }

      if (settings.about_statement) {
        const stmt = document.querySelector('.about-statement');
        if (stmt) stmt.innerHTML = richText(settings.about_statement);
      }
      if (settings.about_info) {
        const info = $('aboutInfoText');
        if (info) info.innerHTML = richText(settings.about_info);
      }

      if (Array.isArray(settings.timeline_items) && settings.timeline_items.length) {
        const tlList = document.querySelector('.timeline-list');
        if (tlList) {
          tlList.innerHTML = settings.timeline_items.map((t, idx) => `
            <li class="time-row reveal in">
              <div class="time-no">${escapeHtml(t.no || pad2(idx + 1))}</div>
              <h3>${escapeHtml(t.title || 'Tahap')}</h3>
              <p>${escapeHtml(t.desc || '')}</p>
              <div class="time-date">${escapeHtml(t.date || '')}</div>
            </li>`).join('');
        }
      }
      renderTimelineStates();
    }

    if (rows && rows.length) {
      candidates = rows.map(r => [
        r.name,
        r.photo_url || PLACEHOLDER,
        r.id,
        r.order_number,
        r.batch ? `ANGKATAN ${r.batch}` : `KANDIDAT ${pad2(r.order_number)}`,
        r.vision || 'Visi kandidat.',
        r.mission || [],
        r.programs || [],
        r.organization_history || 'Riwayat organisasi belum diisi oleh panitia.'
      ]);
      updateVoterUI();
    }
  } catch (err) {
    console.error('Error loading public data:', err);
  }
}

// MODAL VERIFIKASI PEMILIH (2 TAHAP OTP)
function showVoterStep(step) {
  $('voterStep1').style.display = step === 1 ? 'block' : 'none';
  $('voterStep2').style.display = step === 2 ? 'block' : 'none';
}
function openVoterModal(withCandidateIndex = null) {
  pendingVoteIndex = withCandidateIndex;
  $('voterModalErr').textContent = '';
  showVoterStep(1);
  openModal(voterModal, $('inputNim'));
}
const closeVoterModal = () => closeModal(voterModal);
$('voterModalClose').addEventListener('click', closeVoterModal);

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// TAHAP 1: minta OTP ke @mail.ugm.ac.id
$('voterFormStep1').addEventListener('submit', async e => {
  e.preventDefault();
  const rawNim = $('inputNim').value.trim();
  const prefix = $('inputEmailPrefix').value.trim().toLowerCase().replace(/@.*$/, '');
  const errBox = $('voterModalErr');
  const btn = $('btnRequestOtp');
  const label = 'Kirim Kode OTP ke Email UGM';

  if (!rawNim || !prefix) {
    errBox.textContent = 'NIM dan username email UGM wajib diisi.';
    return;
  }

  errBox.textContent = '';
  btn.textContent = 'Mengirim Kode OTP...';
  btn.disabled = true;

  try {
    const { res, data } = await postJson('/api/send-otp', { nim: rawNim, email_prefix: prefix });
    if (!res.ok || !data.success) {
      errBox.textContent = data.error || 'Gagal mengirim kode OTP.';
      return;
    }
    pendingVoterData = { nim: rawNim, email: data.email };
    $('displayTargetEmail').textContent = data.email;
    showVoterStep(2);
    $('inputOtp').value = '';
    $('inputOtp').focus();
  } catch (err) {
    errBox.textContent = 'Terjadi gangguan jaringan. Periksa koneksi lalu coba lagi.';
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
});

$('inputOtp').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
});

// TAHAP 2: verifikasi OTP 6 digit
$('voterFormStep2').addEventListener('submit', async e => {
  e.preventDefault();
  const otp = $('inputOtp').value.trim();
  const errBox = $('voterModalErr');
  const btn = $('btnVerifyOtp');
  const label = 'Verifikasi & Masuk Bilik Suara';

  if (!/^\d{6}$/.test(otp)) {
    errBox.textContent = 'Masukkan 6 digit angka kode OTP.';
    return;
  }

  errBox.textContent = '';
  btn.textContent = 'Memverifikasi OTP...';
  btn.disabled = true;

  try {
    const { res, data } = await postJson('/api/verify-otp', { email: pendingVoterData.email, otp });
    if (!res.ok || !data.success) {
      errBox.textContent = data.error || 'Kode OTP salah atau kedaluwarsa.';
      return;
    }

    sessionStorage.setItem('kmtedi_voter_nim', data.voter.nim);
    sessionStorage.setItem('kmtedi_voter_email', data.voter.email);
    sessionStorage.setItem('kmtedi_ballot_token', data.ballot_token);
    sessionStorage.setItem('kmtedi_has_voted', 'false');

    closeVoterModal();
    updateVoterUI();

    if (pendingVoteIndex !== null) {
      triggerVote(pendingVoteIndex);
      pendingVoteIndex = null;
    } else {
      $('calon').scrollIntoView({ behavior: 'smooth' });
    }
  } catch (err) {
    errBox.textContent = 'Terjadi gangguan jaringan. Periksa koneksi lalu coba lagi.';
  } finally {
    btn.textContent = label;
    btn.disabled = false;
  }
});

$('btnBackToStep1').addEventListener('click', () => {
  $('voterModalErr').textContent = '';
  showVoterStep(1);
});
$('btnResendOtp').addEventListener('click', () => $('voterFormStep1').requestSubmit());

// MODAL PROFIL CALON (3 PANEL)
function renderModal() {
  const c = candidates[selected];
  const no = pad2(c[3] || selected + 1);
  $('modalTitle').textContent = c[0];
  $('modalImage').src = safeImage(c[1], PLACEHOLDER);
  $('modalImage').alt = `Foto ${c[0]}`;
  $('modalNo').textContent = no;
  $('modalLabel').textContent = `CALON ${no} / PROFIL`;

  $('slideBio').textContent = c[4] ? `${c[0]} / ${c[4]}` : c[0];
  $('slideHistory').textContent = c[8] || 'Riwayat organisasi belum diisi oleh panitia.';
  $('slideVision').textContent = c[5] || 'Visi kandidat.';
  $('slideMission').innerHTML = (c[6] && c[6].length) ? c[6].map(m => `<li>${escapeHtml(m)}</li>`).join('') : '<li>Misi kandidat</li>';
  $('slidePrograms').innerHTML = (c[7] && c[7].length) ? c[7].map(p => `<li>${escapeHtml(p)}</li>`).join('') : '<li>Program kerja unggulan</li>';

  for (let i = 0; i < 3; i++) $(`slide${i}`).classList.toggle('active', i === slide);
  document.querySelectorAll('.slide-tab').forEach(t => {
    const active = Number(t.dataset.slide) === slide;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
  $('slideCount').textContent = `${pad2(slide + 1)} / 03`;

  const voteBtn = $('voteFromModalBtn');
  voteBtn.textContent = hasVoted ? 'Sudah Memilih' : `Pilih Calon ${no}`;
  voteBtn.disabled = hasVoted;
}

// Cegah klik kartu saat sedang menggeser carousel calon
let candTouchStartX = 0;
let candTouchStartY = 0;
let candTouchMoved = false;
document.addEventListener('touchstart', e => {
  if (e.target.closest('.candidate-card')) {
    candTouchStartX = e.touches[0].clientX;
    candTouchStartY = e.touches[0].clientY;
    candTouchMoved = false;
  }
}, { passive: true });
document.addEventListener('touchmove', e => {
  if (e.target.closest('.candidate-card')) {
    const dx = Math.abs(e.touches[0].clientX - candTouchStartX);
    const dy = Math.abs(e.touches[0].clientY - candTouchStartY);
    if (dx > 10 || dy > 10) candTouchMoved = true;
  }
}, { passive: true });

function openProfile(i) {
  if (candTouchMoved) { candTouchMoved = false; return; }
  if (!candidates[i]) return;
  selected = i;
  slide = 0;
  renderModal();
  openModal(profileModal);
}
const closeProfile = () => closeModal(profileModal);

const goSlide = n => { slide = (n + 3) % 3; renderModal(); };
$('modalClose').addEventListener('click', closeProfile);
$('nextSlide').addEventListener('click', () => goSlide(slide + 1));
$('prevSlide').addEventListener('click', () => goSlide(slide - 1));
document.querySelectorAll('.slide-tab').forEach(t => t.addEventListener('click', () => goSlide(Number(t.dataset.slide))));
$('voteFromModalBtn').addEventListener('click', () => triggerVote(selected));

// Geser antar panel profil di HP
let pStartX = 0;
let pStartY = 0;
profileModal.addEventListener('touchstart', e => {
  pStartX = e.touches[0].clientX;
  pStartY = e.touches[0].clientY;
}, { passive: true });
profileModal.addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - pStartX;
  const dy = e.changedTouches[0].clientY - pStartY;
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 35) goSlide(slide + (dx < 0 ? 1 : -1));
}, { passive: true });

// TRIGGER PILIH (hanya bisa sekali)
function triggerVote(index) {
  if (!isVotingActive()) {
    const startTime = electionSettings?.voting_start ? new Date(electionSettings.voting_start) : null;
    if (startTime && new Date() < startTime) {
      const opts = { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' };
      showNotice({
        eyebrow: 'STATUS BILIK SUARA',
        title: 'Bilik Suara Belum Dibuka',
        html: true,
        message: `Bilik suara dijadwalkan dibuka resmi pada <b>${escapeHtml(startTime.toLocaleDateString('id-ID', opts))} WIB</b>.<br><br>Sambil menunggu, pelajari profil lengkap, visi misi, dan program kerja calon ketua terlebih dahulu.`,
        primaryText: 'Mengerti',
        secondaryText: 'Lihat Visi Misi',
        onSecondary: () => openProfile(index)
      });
    } else {
      showNotice({
        eyebrow: 'STATUS BILIK SUARA',
        title: 'Bilik Suara Ditutup',
        html: true,
        message: 'Bilik suara saat ini sedang ditutup oleh panitia pemilwa.<br><br>Silakan pantau jadwal dan pengumuman resmi dari panitia.',
        primaryText: 'Mengerti'
      });
    }
    return;
  }

  const v = getVoter();
  if (!v.hasVoted && (!v.nim || !v.email || !v.token)) {
    closeProfile();
    openVoterModal(index);
    return;
  }

  if (v.hasVoted) {
    showNotice({
      eyebrow: 'VERIFIKASI SUARA',
      title: 'Hak Suara Telah Digunakan',
      html: true,
      message: `NIM <b>${escapeHtml(v.nim)}</b> sudah tercatat pernah memberikan hak suara.<br><br>Sesuai asas Pemilwa KMTEDI (satu mahasiswa, satu suara), pemilihan hanya dapat dilakukan satu kali dan tidak dapat diubah.`,
      primaryText: 'Mengerti'
    });
    return;
  }

  candidateToVote = candidates[index];
  if (!candidateToVote) return;
  const no = pad2(candidateToVote[3] || index + 1);
  $('confirmPhoto').src = safeImage(candidateToVote[1], PLACEHOLDER);
  $('confirmNo').textContent = `PASLON NOMOR URUT ${no}`;
  $('confirmName').textContent = candidateToVote[0];
  $('confirmBatch').textContent = candidateToVote[4] || 'CALON KETUA KMTEDI';
  $('confirmVoterDetails').textContent = `NIM: ${v.nim} / ${v.email}`;

  closeProfile();
  openModal(confirmVoteModal, $('cancelVoteBtn'));
}

const closeDoubleCheck = () => closeModal(confirmVoteModal);

// KIRIM SUARA FINAL
$('submitVoteFinalBtn').addEventListener('click', async () => {
  if (!candidateToVote) return;
  const v = getVoter();
  if (!v.nim || !v.email || !v.token) {
    closeDoubleCheck();
    openVoterModal();
    return;
  }

  const btn = $('submitVoteFinalBtn');
  btn.textContent = 'Memproses Suara...';
  btn.disabled = true;

  try {
    const { res, data } = await postJson('/api/cast-vote', { ballot_token: v.token, candidate_id: candidateToVote[2] });

    if (!res.ok || !data.success) {
      const msg = data.error || 'Gagal mengirim suara.';
      if (/sudah menggunakan hak suara/i.test(msg)) {
        sessionStorage.setItem('kmtedi_has_voted', 'true');
        sessionStorage.removeItem('kmtedi_ballot_token');
        closeDoubleCheck();
        updateVoterUI();
      } else if (res.status === 401 || /sesi pemilih/i.test(msg)) {
        sessionStorage.removeItem('kmtedi_ballot_token');
        closeDoubleCheck();
        updateVoterUI();
        openVoterModal();
      }
      alert('Gagal Mengirim Suara:\n\n' + msg);
      return;
    }

    sessionStorage.setItem('kmtedi_has_voted', 'true');
    sessionStorage.removeItem('kmtedi_ballot_token');
    hasVoted = true;

    closeDoubleCheck();
    $('successReceiptText').innerHTML = `
      NIM: <b>${escapeHtml(v.nim)}</b> (${escapeHtml(v.email)}).<br>
      Hak suara Anda telah berhasil dicatat secara sah dan rahasia ke kotak suara Pemilwa KMTEDI 2026.`;
    openModal(successModal, $('successCloseBtn'));
    updateVoterUI();
  } catch (err) {
    alert('Terjadi kesalahan jaringan. Suara belum terkirim, silakan coba lagi.');
  } finally {
    btn.textContent = 'Kirim Suara Sah';
    btn.disabled = false;
  }
});

$('cancelVoteBtn').addEventListener('click', closeDoubleCheck);
$('confirmModalClose').addEventListener('click', closeDoubleCheck);
$('successCloseBtn').addEventListener('click', () => closeModal(successModal));

// CUSTOM ON-BRAND NOTICE POPUP (MENGGANTIKAN BROWSER ALERT)
function showNotice({
  title = 'Pemberitahuan',
  message = '',
  eyebrow = 'INFORMASI PEMILWA',
  primaryText = 'Mengerti',
  onPrimary = null,
  secondaryText = '',
  onSecondary = null,
  html = false
} = {}) {
  if (!noticeModal) return;
  $('noticeEyebrow').textContent = eyebrow;
  $('noticeTitle').textContent = title;
  $('noticeMessage').innerHTML = html ? String(message) : richText(message);

  const pBtn = $('noticePrimaryBtn');
  pBtn.textContent = primaryText;
  pBtn.onclick = () => {
    closeNotice();
    if (onPrimary) onPrimary();
  };

  const sBtn = $('noticeSecondaryBtn');
  if (secondaryText) {
    sBtn.textContent = secondaryText;
    sBtn.style.display = 'inline-flex';
    sBtn.onclick = () => {
      closeNotice();
      if (onSecondary) onSecondary();
    };
  } else {
    sBtn.style.display = 'none';
  }
  openModal(noticeModal, pBtn);
}

function closeNotice() { closeModal(noticeModal); }
$('noticeModalClose').addEventListener('click', closeNotice);

// Override window.alert global ke modal bertema KMTEDI
window.originalAlert = window.alert;
window.alert = function(msg) {
  let title = 'Pemberitahuan';
  let eyebrow = 'INFORMASI PEMILWA';
  const text = String(msg || '');
  const lower = text.toLowerCase();
  if (lower.includes('gagal') || lower.includes('kesalahan') || lower.includes('error')) {
    title = 'Perhatian';
    eyebrow = 'STATUS SISTEM';
  } else if (lower.includes('belum dibuka') || lower.includes('ditutup')) {
    title = 'Bilik Suara Belum Dibuka';
    eyebrow = 'STATUS BILIK SUARA';
  } else if (lower.includes('sudah pernah') || lower.includes('sudah menggunakan')) {
    title = 'Hak Suara Telah Digunakan';
    eyebrow = 'VERIFIKASI SUARA';
  }
  showNotice({ eyebrow, title, message: text, primaryText: 'Mengerti' });
};

// Klik latar modal untuk menutup
[voterModal, profileModal, confirmVoteModal, successModal, noticeModal].forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) closeModal(m); });
});

// TOMBOL UTAMA BILIK SUARA
$('mainVoteBtn').addEventListener('click', () => {
  const v = getVoter();
  if (!v.nim || !v.email || (!v.token && !v.hasVoted)) {
    openVoterModal();
  } else if (!hasVoted) {
    $('calon').scrollIntoView({ behavior: 'smooth' });
  }
});

// DELEGASI KLIK: verifikasi, ganti pemilih, profil, pilih, kartu calon
document.addEventListener('click', e => {
  const actionEl = e.target.closest('[data-action]');
  if (actionEl) {
    const index = Number(actionEl.dataset.index);
    switch (actionEl.dataset.action) {
      case 'open-voter': openVoterModal(); return;
      case 'clear-voter': clearVoterSession(); return;
      case 'profile': openProfile(index); return;
      case 'vote': triggerVote(index); return;
    }
  }
  const card = e.target.closest('.candidate-card');
  if (card) openProfile(Number(card.dataset.index));
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeNotice();
    closeProfile();
    closeDoubleCheck();
    closeVoterModal();
    closeModal(successModal);
  }
  if (profileModal.classList.contains('open') && e.key === 'ArrowRight') goSlide(slide + 1);
  if (profileModal.classList.contains('open') && e.key === 'ArrowLeft') goSlide(slide - 1);
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList?.contains('candidate-card')) {
    e.preventDefault();
    openProfile(Number(e.target.dataset.index));
  }
});

// SINKRON CAROUSEL CALON DI HP
const candGrid = document.querySelector('.candidate-grid');
const candDots = [...document.querySelectorAll('.cand-dot')];
if (candGrid && candDots.length) {
  candGrid.addEventListener('scroll', () => {
    const card = candGrid.querySelector('.candidate-card');
    const step = card ? (card.offsetWidth + 14) : 1;
    const activeIdx = Math.min(candDots.length - 1, Math.max(0, Math.round(candGrid.scrollLeft / step)));
    candDots.forEach((dot, idx) => dot.classList.toggle('active', idx === activeIdx));
  }, { passive: true });

  candDots.forEach((dot, idx) => {
    dot.addEventListener('click', () => {
      const card = $(`candCard${idx}`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
    });
  });
}

// INIT
renderTimelineStates();
updateVotingStatus();
updateVoterUI();
loadPublicData();
})();
