// app.js — multi-photo → OCR → short ID → local log + Google Sheets + Drive upload

// ---------- CONFIG ----------
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzXYKl5Wi1iOplK9d4mZNHtg-H70H9lb07JkitkPrl0Zb7pVoh8sPYWTxzicUtlE-a4/exec';
const MAX_IMAGE_SIDE = 2000; // px
const JPEG_QUALITY = 0.85;

// ---------- Base64url (no padding) ----------
function b64UrlEncode(bytes) {
  let bin = '';
  for (let b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function b64UrlDecode(s) {
  s = s.trim().replace(/-/g,'+').replace(/_/g,'/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const arr = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// ---------- Pack YYYY/MM/DD + cents into 48 bits (6 bytes) ----------
function packDateAmount(yyyy, mm, dd, cents) {
  if (!(Number.isInteger(yyyy) && 0 <= yyyy && yyyy <= 16383)) throw new Error("Year out of range (0..16383)");
  if (!(Number.isInteger(mm) && 1 <= mm && mm <= 12)) throw new Error("Month must be 1..12");
  if (!(Number.isInteger(dd) && 1 <= dd && dd <= 31)) throw new Error("Day must be 1..31");
  if (!(Number.isInteger(cents) && 0 <= cents && cents <= ((1<<25)-1))) throw new Error("Amount too large (max 33,554,431 cents)");
  let v = BigInt(yyyy);
  v = (v << 34n) | (BigInt(mm) << 30n) | (BigInt(dd) << 25n) | BigInt(cents);
  const out = new Uint8Array(6);
  for (let i=5;i>=0;i--) { out[i] = Number(v & 0xFFn); v >>= 8n; }
  return out;
}

// ---------- Short ID encoders (v1/v2) ----------
function encodeV1(yyyy, mm, dd, cents) {
  const b6 = packDateAmount(yyyy, mm, dd, cents);
  return b64UrlEncode(b6);
}
function encodeV2(yyyy, mm, dd, cents, variant) {
  const b6 = packDateAmount(yyyy, mm, dd, cents);
  const v = (variant == null || isNaN(variant)) ? (Math.floor(Math.random()*256) & 0xFF) : Math.max(0, Math.min(255, variant|0));
  const buf = new Uint8Array(7);
  buf[0] = v;
  buf.set(b6, 1);
  return { token: b64UrlEncode(buf), variant: v };
}

// ---------- Helpers ----------
const $ = (id) => document.getElementById(id);
const state = { lat: null, lon: null, rows: [] };

function todayYMD() {
  const d = new Date();
  const y = d.getFullYear().toString().padStart(4,'0');
  const m = (d.getMonth()+1).toString().padStart(2,'0');
  const da = d.getDate().toString().padStart(2,'0');
  return y+m+da;
}
function priceStringToCents(s) {
  const m = String(s ?? '').trim().match(/^(\d{1,3}(?:,\d{3})*|\d+)(?:[.,](\d{1,2}))?$/);
  if (!m) throw new Error("Amount must look like 12 or 1,234.56");
  const dollars = parseInt(m[1].replace(/,/g,''),10);
  const centsPart = m[2] ? m[2].padEnd(2,'0') : '00';
  return dollars*100 + parseInt(centsPart,10);
}
function centsToDollars(cents) { return (cents/100).toFixed(2); }

// Read a File -> dataURL
function readFileAsDataURL(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(file);
  });
}
// Downscale/compress image to JPEG dataURL
async function compressImageDataURL(srcDataURL, maxSize = MAX_IMAGE_SIDE, quality = JPEG_QUALITY) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((r, e) => { img.onload = r; img.onerror = e; img.src = srcDataURL; });
  let { width:w, height:h } = img;
  if (Math.max(w,h) > maxSize) {
    const scale = maxSize / Math.max(w,h);
    w = Math.round(w*scale); h = Math.round(h*scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

// ---------- OCR via Tesseract ----------
async function ocrImage(file) {
  $('status').textContent = 'Running OCR…';
  const dataURL = await readFileAsDataURL(file);
  try {
    const result = await Tesseract.recognize(dataURL, 'eng', { logger: m => {} });
    const text = result.data.text || '';
    $('status').textContent = 'OCR done.';
    return text;
  } catch (e) {
    $('status').textContent = 'OCR failed.';
    throw e;
  }
}
function extractFirstPriceFromText(text) {
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const pats = [
    /\$\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})?)/,
    /\$\s*([0-9]+(?:[.,][0-9]{2}))/,
    /\b([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2}))\b/,
    /\b([0-9]+[.,][0-9]{2})\b/
  ];
  for (const line of lines) {
    for (const rx of pats) {
      const m = line.match(rx);
      if (m) {
        let s = m[1].replace(/,/g,'');
        if (s.includes(',')) s = s.replace(',','.');
        return s;
      }
    }
  }
  return null;
}

// ---------- Records (local) ----------
const STORAGE_KEY = 'arttag_records_v1';
function loadRecords() { try { state.rows = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { state.rows = []; } }
function saveRecords() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.rows)); }
function addRow(row) { state.rows.unshift(row); saveRecords(); renderTable(); }
function clearRecords() { state.rows = []; saveRecords(); renderTable(); }
function renderTable() {
  const tb = $('table').querySelector('tbody');
  tb.innerHTML = '';
  for (const r of state.rows) {
    const tr = document.createElement('tr');
    const created = new Date(r.created_at).toISOString().replace('T',' ').slice(0,19);
    const date = r.date_yyyymmdd;
    const price = `$${centsToDollars(r.price_cents)}`;
    const final$ = `$${centsToDollars(r.final_cents)}`;
    tr.innerHTML = `
      <td>${created}</td>
      <td><span class="mono">${date}</span></td>
      <td>${price}</td>
      <td>${r.half_off ? 'Yes' : 'No'}</td>
      <td>${final$}</td>
      <td><span class="mono">${r.token}</span></td>
      <td>${r.version}</td>
      <td>${r.variant ?? ''}</td>
      <td>${r.lat ?? ''}</td>
      <td>${r.lon ?? ''}</td>
    `;
    tb.appendChild(tr);
  }
}
function toCSV(rows) {
  const headers = ['created_at','date_yyyymmdd','price_cents','half_off','final_cents','token','version','variant','lat','lon'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    const vals = [
      new Date(r.created_at).toISOString(),
      r.date_yyyymmdd,
      r.price_cents,
      r.half_off ? 1 : 0,
      r.final_cents,
      r.token,
      r.version,
      r.variant ?? '',
      r.lat ?? '',
      r.lon ?? ''
    ];
    lines.push(vals.map(v => String(v).replace(/"/g,'""')).join(','));
  }
  return lines.join('\n');
}
function downloadCSV() {
  const csv = toCSV(state.rows);
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'arttag_records.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- UI wiring ----------
function initDefaults() { $('date').value = todayYMD(); }

$('photo').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  const gal = $('gallery'); gal.innerHTML = '';
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const img = document.createElement('img');
    img.src = url; img.className = 'thumb';
    gal.appendChild(img);
    img.onload = () => URL.revokeObjectURL(url);
  }
  $('status').textContent = files.length ? `${files.length} photo(s) loaded.` : 'No photos selected.';
});

$('runOcr').addEventListener('click', async () => {
  const file = ($('photo').files || [])[0];
  if (!file) { alert('Choose at least one photo first'); return; }
  try {
    const text = await ocrImage(file);
    const priceStr = extractFirstPriceFromText(text);
    if (priceStr) {
      $('price').value = priceStr;
      $('status').textContent = 'Price detected: $' + priceStr;
    } else {
      $('status').textContent = 'No obvious price found. Edit the field manually.';
    }
  } catch (e) { alert('OCR failed: ' + (e.message || e)); }
});

$('gen').addEventListener('click', () => {
  try {
    const d = $('date').value.trim();
    if (!/^\d{8}$/.test(d)) throw new Error("Date must be YYYYMMDD");
    const yyyy = parseInt(d.slice(0,4),10);
    const mm   = parseInt(d.slice(4,6),10);
    const dd   = parseInt(d.slice(6,8),10);
    const priceStr = $('price').value.trim();
    if (!priceStr) throw new Error("Enter price or run OCR");
    const cents = priceStringToCents(priceStr);
    const half = $('halfOff').checked;
    const finalCents = half ? Math.round(cents / 2) : cents;
    const ver = $('version').value;
    if (ver === 'v1') {
      const tok = encodeV1(yyyy, mm, dd, finalCents);
      $('token').value = tok; $('status').textContent = 'Token (v1) generated.';
    } else {
      const inputV = $('variant').value.trim();
      const v = inputV === '' ? null : Number(inputV);
      const { token, variant } = encodeV2(yyyy, mm, dd, finalCents, v);
      $('variant').value = String(variant);
      $('token').value = token; $('status').textContent = 'Token (v2) generated, variant ' + variant + '.';
    }
  } catch (e) { alert(e.message || String(e)); }
});

$('save').addEventListener('click', async () => {
  try {
    const d = $('date').value.trim();
    if (!/^\d{8}$/.test(d)) throw new Error("Date must be YYYYMMDD");
    const yyyy = parseInt(d.slice(0,4),10);
    const mm   = parseInt(d.slice(4,6),10);
    const dd   = parseInt(d.slice(6,8),10);
    const priceStr = $('price').value.trim();
    if (!priceStr) throw new Error("Enter price");
    const cents = priceStringToCents(priceStr);
    const half = $('halfOff').checked;
    const finalCents = half ? Math.round(cents / 2) : cents;
    const ver = $('version').value;
    const tok = $('token').value.trim() || (ver === 'v1'
      ? encodeV1(yyyy, mm, dd, finalCents)
      : encodeV2(yyyy, mm, dd, finalCents).token);
    const variant = ver === 'v2' ? Number($('variant').value || '0') : null;

    // Collect & compress selected photos
    const files = Array.from(($('photo').files || []));
    const images = [];
    for (let i = 0; i < files.length; i++) {
      const raw = await readFileAsDataURL(files[i]);
      const jpeg = await compressImageDataURL(raw, MAX_IMAGE_SIDE, JPEG_QUALITY);
      images.push(jpeg);
    }

    const row = {
      created_at: Date.now(),
      date_yyyymmdd: d,
      price_cents: cents,
      half_off: half,
      final_cents: finalCents,
      token: tok,
      version: ver,
      variant: ver === 'v2' ? variant : null,
      lat: state.lat,
      lon: state.lon,
      images
    };

    addRow(row); // local
    $('status').textContent = 'Uploading to Google Sheets & Drive…';

    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(row)
    });
    const text = await res.text();
    if (!res.ok) throw new Error(text || 'Upload failed');
    $('status').textContent = 'Saved locally & uploaded to Sheets/Drive.';
  } catch (e) { alert(e.message || String(e)); }
});

$('export').addEventListener('click', () => downloadCSV());
$('clear').addEventListener('click', () => { if (confirm('Clear all saved records?')) clearRecords(); });
$('getLoc').addEventListener('click', () => {
  if (!('geolocation' in navigator)) { alert('Geolocation not available'); return; }
  $('status').textContent = 'Getting GPS…';
  navigator.geolocation.getCurrentPosition((pos) => {
    state.lat = pos.coords.latitude.toFixed(6);
    state.lon = pos.coords.longitude.toFixed(6);
    $('lat').value = state.lat; $('lon').value = state.lon;
    $('status').textContent = 'GPS ready.';
  }, (err) => {
    $('status').textContent = 'GPS failed or denied.';
    alert('Location error: ' + err.message);
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
});

loadRecords(); renderTable(); initDefaults();
