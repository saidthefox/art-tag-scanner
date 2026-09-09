// app.js — rescued.art Studio: capture pieces, review the model's read, publish.
'use strict';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js'));
}

const CONFIG = {
  API_BASE: 'https://api.rescued.art',
  MAX_IMAGE_SIDE: 2000,
  JPEG_QUALITY: 0.85,
};

const AUTH_KEY = 'rescued_studio_session_v1';

const ROLE_LABELS = {
  tag: 'Price tag', front_close: 'White-wall close', front_wide: 'White-wall wide',
  in_situ: 'In a room', signature: 'Signature', back: 'Back of piece', unsorted: 'Unsorted',
};
const SLOT_ORDER = ['front_close', 'front_wide', 'in_situ', 'signature', 'back', 'tag', 'unsorted'];

const $ = (id) => document.getElementById(id);
const state = { lat: null, lon: null, files: [], detail: null, auth: localStorage.getItem(AUTH_KEY) || '' };

/* ----------------------- helpers ----------------------- */
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.auth) headers.Authorization = `Bearer ${state.auth}`;
  const r = await fetch(`${CONFIG.API_BASE}${path}`, {
    ...opts,
    headers,
  });
  const text = await r.text();
  if (r.status === 401) setAuthenticated(false);
  if (!r.ok) throw new Error(`${r.status}: ${text || r.statusText}`);
  return text ? JSON.parse(text) : {};
}
function setAuthenticated(ok, token = '') {
  if (ok && token) {
    state.auth = token;
    localStorage.setItem(AUTH_KEY, token);
  } else if (!ok) {
    state.auth = '';
    localStorage.removeItem(AUTH_KEY);
  }
  $('viewLogin').classList.toggle('hidden', ok);
  $('studioApp').classList.toggle('hidden', !ok);
  $('logout').classList.toggle('hidden', !ok);
  if (ok) show('Capture');
}
async function login() {
  const password = $('loginPassword').value;
  $('loginStatus').textContent = 'Signing in…';
  try {
    const r = await fetch(`${CONFIG.API_BASE}/api/admin/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(r.status === 401 ? 'Incorrect password.' : `${r.status}: ${text}`);
    const data = JSON.parse(text);
    $('loginPassword').value = '';
    $('loginStatus').textContent = '';
    setAuthenticated(true, data.token);
  } catch (e) { $('loginStatus').textContent = e.message || String(e); }
}
async function bootAuth() {
  if (!state.auth) return setAuthenticated(false);
  try { await api('/api/admin/session'); setAuthenticated(true); }
  catch (_) { setAuthenticated(false); }
}
function readFileAsDataURL(file) {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(file); });
}
async function compress(srcDataURL) {
  const img = new Image();
  await new Promise((r, e) => { img.onload = r; img.onerror = e; img.src = srcDataURL; });
  let { width: w, height: h } = img;
  const m = CONFIG.MAX_IMAGE_SIDE;
  if (Math.max(w, h) > m) { const s = m / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', CONFIG.JPEG_QUALITY);
}
const centsToStr = (c) => (c == null ? '' : (c / 100).toFixed(2));
function strToCents(s) {
  s = String(s ?? '').trim(); if (!s) return null;
  const m = s.match(/^\$?\s*(\d+(?:[.,]\d{1,2})?)$/); if (!m) return null;
  return Math.round(parseFloat(m[1].replace(',', '.')) * 100);
}

/* ----------------------- tabs ----------------------- */
function show(view) {
  for (const v of ['Capture', 'Review', 'Detail']) $('view' + v).classList.toggle('hidden', v !== view);
  $('tabCapture').classList.toggle('active', view === 'Capture');
  $('tabReview').classList.toggle('active', view !== 'Capture');
}
$('tabCapture').onclick = () => show('Capture');
$('tabReview').onclick = () => { show('Review'); loadList(); };

/* ----------------------- capture ----------------------- */
function renderGallery() {
  const g = $('gallery'); g.innerHTML = '';
  state.files.forEach((f) => {
    const url = URL.createObjectURL(f); const img = document.createElement('img');
    img.src = url; img.className = 'thumb'; img.onload = () => URL.revokeObjectURL(url); g.appendChild(img);
  });
  $('status').textContent = state.files.length ? `${state.files.length} photo(s) ready.` : 'Ready.';
}
$('photo').addEventListener('change', (e) => { state.files = state.files.concat(Array.from(e.target.files || [])); renderGallery(); e.target.value = ''; });

$('getLoc').onclick = () => {
  if (!('geolocation' in navigator)) return alert('Geolocation not available');
  $('status').textContent = 'Getting GPS…';
  navigator.geolocation.getCurrentPosition(
    (p) => { state.lat = p.coords.latitude.toFixed(6); state.lon = p.coords.longitude.toFixed(6); $('status').textContent = 'GPS ready (kept private).'; },
    (err) => { $('status').textContent = 'GPS failed: ' + err.message; },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
};

/* offline backup of failed uploads (stores the photos so retry truly works) */
const PENDING_KEY = 'rescued_pending_v1';
const loadPending = () => { try { return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]'); } catch { return []; } };
const savePending = (p) => { try { localStorage.setItem(PENDING_KEY, JSON.stringify(p)); } catch (e) { console.warn('pending save failed', e); } };
function renderPending() {
  const p = loadPending(); $('pendingN').textContent = p.length;
  $('pendingWrap').classList.toggle('hidden', p.length === 0);
}
async function postPiece(body) { return api('/ingest', { method: 'POST', body: JSON.stringify(body) }); }

$('upload').onclick = async () => {
  if (!state.files.length) return alert('Add at least one photo first');
  $('upload').disabled = true; $('status').textContent = 'Compressing…';
  try {
    const images = [];
    for (const f of state.files) images.push(await compress(await readFileAsDataURL(f)));
    const body = { images, lat: state.lat, lon: state.lon };
    $('status').textContent = 'Uploading…';
    try {
      const out = await postPiece(body);
      const where = out.foundLocation ? ` · filed under ${out.foundLocation}` : '';
      $('status').textContent = `Uploaded ${out.count} photo(s)${where}. Token ${out.token} — the model is reading it now; check the Review tab in a moment.`;
      state.files = []; state.lat = state.lon = null; renderGallery();
    } catch (e) {
      const p = loadPending(); p.push({ ...body, ts: Date.now() }); savePending(p); renderPending();
      $('status').textContent = `Upload failed — saved locally to retry. ${e.message}`;
    }
  } catch (e) { $('status').textContent = 'Error: ' + (e.message || e); }
  finally { $('upload').disabled = false; }
};
$('retry').onclick = async () => {
  let p = loadPending(); if (!p.length) return;
  $('status').textContent = `Retrying ${p.length}…`; let ok = 0; const left = [];
  for (const item of p) { try { await postPiece(item); ok++; } catch { left.push(item); } }
  savePending(left); renderPending();
  $('status').textContent = `Retried ${ok}/${p.length}.`;
};

/* ----------------------- review list ----------------------- */
async function loadList() {
  $('reviewStatus').textContent = 'Loading…'; $('cards').innerHTML = '';
  try {
    const { pieces } = await api('/api/admin/pieces');
    $('reviewStatus').textContent = pieces.length ? '' : 'No pieces yet — capture one.';
    for (const p of pieces) {
      const el = document.createElement('div'); el.className = 'card'; el.onclick = () => openDetail(p.token);
      const badges = [
        p.published ? '<span class="badge b-pub">published</span>' : '<span class="badge b-draft">draft</span>',
        p.reviewStatus === 'pending' ? '<span class="badge b-pending">analyzing…</span>'
          : p.reviewStatus === 'analyzed' ? '<span class="badge b-analyzed">analyzed</span>' : '',
      ].join('');
      el.innerHTML = `<img src="${p.hero || ''}" alt="" onerror="this.style.visibility='hidden'">
        <div class="meta"><div class="t">${p.title || '(untitled)'}</div>
        <div class="mono muted" style="font-size:.78rem">${p.token}</div>${badges}</div>`;
      $('cards').appendChild(el);
    }
  } catch (e) { $('reviewStatus').textContent = 'Error: ' + e.message; }
}
$('refresh').onclick = loadList;

/* ----------------------- detail ----------------------- */
async function openDetail(token) {
  show('Detail'); $('detailStatus').textContent = 'Loading…';
  try {
    const d = await api(`/api/admin/pieces/${encodeURIComponent(token)}`);
    state.detail = d;
    $('dToken').textContent = d.token;
    $('dBadges').innerHTML = (d.published ? '<span class="badge b-pub">published</span>' : '<span class="badge b-draft">draft</span>')
      + (d.reviewStatus === 'pending' ? '<span class="badge b-pending">analyzing…</span>' : '');
    $('publish').textContent = d.published ? 'Unpublish' : 'Publish';
    $('publish').className = d.published ? 'secondary' : '';
    $('fTitle').value = d.title; $('fDesc').value = d.description;
    $('fSocial').value = d.socialCopy || '';
    $('fAnnounce').checked = false;
    $('fMedium').value = d.medium; $('fDims').value = d.dimensions; $('fYear').value = d.yearMade;
    $('fStatus').value = d.status || '';
    $('fSale').value = centsToStr(d.salePriceCents); $('fRent').value = centsToStr(d.rentPriceCents);
    $('fAcq').value = d.acquiredDate || ''; $('fCost').value = centsToStr(d.costCents); $('fHalf').checked = !!d.halfOff;
    $('fFound').textContent = d.foundAt ? `Found at: ${d.foundAt}` : 'No Goodwill matched from GPS.';
    const deliveries = d.socialDeliveries || [];
    $('socialState').textContent = deliveries.length
      ? deliveries.map(x => `${x.platform}: ${x.status}${x.last_error ? ' — ' + x.last_error : ''}`).join(' · ')
      : 'Not queued.';
    $('queueSocial').classList.toggle('hidden', !d.published);
    renderSlots(d.images);
    $('detailStatus').textContent = '';
  } catch (e) { $('detailStatus').textContent = 'Error: ' + e.message; }
}
$('back').onclick = () => { show('Review'); loadList(); };

function renderSlots(images) {
  const wrap = $('slots'); wrap.innerHTML = '';
  const byRole = {}; for (const im of images) (byRole[im.role] ||= []).push(im);
  for (const role of SLOT_ORDER) {
    const imgs = byRole[role] || [];
    if (role === 'unsorted' && !imgs.length) continue;
    const slot = document.createElement('div');
    slot.className = 'slot' + (imgs.length ? '' : ' empty');
    slot.innerHTML = `<h4>${ROLE_LABELS[role]}${imgs.length ? '' : ' — empty'}</h4>`;
    for (const im of imgs) {
      const opts = SLOT_ORDER.map((r) => `<option value="${r}" ${r === im.role ? 'selected' : ''}>${ROLE_LABELS[r]}</option>`).join('');
      const div = document.createElement('div'); div.className = 'slotimg'; div.style.marginTop = '8px';
      div.innerHTML = `<img src="${im.url}" alt=""><select data-img="${im.id}" style="flex:1">${opts}</select>`;
      slot.appendChild(div);
    }
    wrap.appendChild(slot);
  }
  wrap.querySelectorAll('select[data-img]').forEach((sel) => {
    sel.onchange = async () => {
      sel.disabled = true;
      try { await api(`/api/admin/images/${sel.dataset.img}`, { method: 'PATCH', body: JSON.stringify({ role: sel.value }) }); await openDetail(state.detail.token); }
      catch (e) { alert('Could not move photo: ' + e.message); sel.disabled = false; }
    };
  });
}

async function patchPiece(fields, note) {
  $('detailStatus').textContent = note || 'Saving…';
  return api(`/api/pieces/${encodeURIComponent(state.detail.token)}`, { method: 'PATCH', body: JSON.stringify(fields) });
}
$('save').onclick = async () => {
  try {
    await patchPiece({
      title: $('fTitle').value.trim(), description: $('fDesc').value.trim(),
      social_copy: $('fSocial').value.trim(),
      medium: $('fMedium').value.trim(), dimensions: $('fDims').value.trim(),
      year_made: $('fYear').value.trim(), status: $('fStatus').value,
      sale_price_cents: strToCents($('fSale').value), rent_price_cents: strToCents($('fRent').value),
      acquired_date: $('fAcq').value || null, cost_cents: strToCents($('fCost').value),
      half_off: $('fHalf').checked,
    });
    $('detailStatus').textContent = 'Saved.';
  } catch (e) { $('detailStatus').textContent = 'Error: ' + e.message; }
};
$('publish').onclick = async () => {
  const next = !state.detail.published;
  try {
    const out = await patchPiece({
      published: next,
      social_copy: $('fSocial').value.trim(),
      announce: next && $('fAnnounce').checked,
    }, next ? 'Publishing…' : 'Unpublishing…');
    if (out?.socialQueued) $('detailStatus').textContent = `Published and queued ${out.socialQueued} social posts.`;
    await openDetail(state.detail.token);
  }
  catch (e) { $('detailStatus').textContent = 'Error: ' + e.message; }
};
$('queueSocial').onclick = async () => {
  try {
    const out = await patchPiece({ social_copy: $('fSocial').value.trim(), announce: true }, 'Queueing…');
    $('detailStatus').textContent = out?.socialQueued ? `Queued ${out.socialQueued} social posts.` : 'Already queued.';
    await openDetail(state.detail.token);
  } catch (e) { $('detailStatus').textContent = 'Error: ' + e.message; }
};
$('reanalyze').onclick = async () => {
  try {
    await api(`/api/admin/pieces/${encodeURIComponent(state.detail.token)}/reanalyze`, { method: 'POST' });
    $('detailStatus').textContent = 'Re-running the model… refresh in a moment.';
  } catch (e) { $('detailStatus').textContent = 'Error: ' + e.message; }
};

/* ----------------------- boot ----------------------- */
$('loginButton').onclick = login;
$('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
$('logout').onclick = () => setAuthenticated(false);
renderGallery(); renderPending(); bootAuth();
