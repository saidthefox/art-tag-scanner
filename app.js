/* app.js — camera → OCR → short ID → local log + CSV, PWA-friendly */

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

async function ocrImage(file) {
  $('status').textContent = 'Running OCR…';
  const imgUrl = URL.createObjectURL(file);
  try {
    const result = await Tesseract.recognize(imgUrl, 'eng', { logger: m => {} });
    const text = result.data.text || '';
    $('status').textContent = 'OCR done.';
    return text;
  } catch (e) {
    $('status').textContent = 'OCR failed.';
    throw e;
  } finally {
    URL.revokeObjectURL(imgUrl);
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

function initDefaults() { $('date').value = todayYMD(); }

$('photo').addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  $('preview').src = url;
  $('status').textContent = 'Photo loaded.';
});
$('runOcr').addEventListener('click', async () => {
  const file = $('photo').files && $('photo').files[0];
  if (!file) { alert('Choose a photo first'); return; }
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
$('save').addEventListener('click', () => {
  try {
    const d = $('date').value.trim();
    if (!/^\d{8}$/.test(d)) throw new Error("Date must be YYYYMMDD");
    const priceStr = $('price').value.trim();
    if (!priceStr) throw new Error("Enter price");
    const cents = priceStringToCents(priceStr);
    const half = $('halfOff').checked;
    const finalCents = half ? Math.round(cents / 2) : cents;
    const ver = $('version').value;
    const tok = $('token').value.trim() || (ver === 'v1' ? encodeV1(parseInt(d.slice(0,4),10), parseInt(d.slice(4,6),10), parseInt(d.slice(6,8),10), finalCents)
                                                   : encodeV2(parseInt(d.slice(0,4),10), parseInt(d.slice(4,6),10), parseInt(d.slice(6,8),10), finalCents).token);
    const variant = ver === 'v2' ? Number($('variant').value || '0') : null;
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
      lon: state.lon
    };
    addRow(row);
    $('status').textContent = 'Saved.';
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

async function sendToSheet(row) {
  const url = 'https://script.google.com/macros/s/AKfycbzXYKl5Wi1iOplK9d4mZNHtg-H70H9lb07JkitkPrl0Zb7pVoh8sPYWTxzicUtlE-a4/exec'; // from step 3
  try {
    const res = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(row),
      headers: { 'Content-Type': 'application/json' }
    });
    if (!res.ok) throw new Error(await res.text());
    $('status').textContent = 'Saved to Google Sheets.';
  } catch (e) {
    $('status').textContent = 'Google Sheets sync failed: ' + (e.message||e);
  }
}

