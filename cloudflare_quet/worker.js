// Ghi đơn quét nhanh vào Google Sheet "Danh Sách ĐH" (thay bước ghi qua Apps Script, ~2s -> <1s).
// Trang quét lấy "vé" từ Apps Script lúc mở (quetTrangThai, đã xác thực Telegram + quyền), gửi vé + mã về đây.
// Bí mật (wrangler secret): VE_KHOA (chung với Apps Script), GOOGLE_SA (nội dung credentials.json).
const SHEET_ID = '1-uxpKDh-1bBvVS4VI6xHSi1o5IeYHKwtBVYMDiowgtw';
const QDON = { DI: { tab: 'Trang tính1', them: ['Người quét', 'Ảnh'] }, HOAN: { tab: 'Don_Hoan', them: ['Ảnh'] } };
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };

function json(o, st) { return new Response(JSON.stringify(o), { status: st || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) }); }

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST') return json({ ok: true, ten: 'quet-don' });
    // mọi lần ghi đi qua 1 Durable Object -> xếp hàng như LockService, không trùng STT
    const id = env.KHOA_QUET.idFromName('chung');
    return env.KHOA_QUET.get(id).fetch(req);
  },
};

export class KhoaQuet {
  constructor(state, env) { this.state = state; this.env = env; this.tok = null; this.hetTok = 0; this.hang = Promise.resolve(); }
  async fetch(req) {
    let p;
    try { p = await req.json(); } catch (e) { return json({ ok: false, text: 'Dữ liệu gửi lên không đọc được.' }); }
    const viec = this.hang.then(() => this.quetDon(p));
    this.hang = viec.catch(() => {});
    try { return json(await viec); } catch (e) { return json({ ok: false, text: String(e.message || e), loiMay: true }); }
  }

  // ----- xác thực vé
  async kiemVe(ve) {
    const [pl, sig] = String(ve || '').split('.');
    if (!pl || !sig) throw new Error('Thiếu vé – mở lại trang quét từ bot.');
    const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(this.env.VE_KHOA).trim()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const s = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(pl))));
    if (s.replace(/=+$/, '') !== sig.replace(/=+$/, '')) throw new Error('Vé không hợp lệ – mở lại trang quét từ bot.');
    const v = JSON.parse(new TextDecoder().decode(unb64url(pl)));
    if (!v.e || Date.now() > v.e) throw new Error('Vé hết hạn – đóng và mở lại trang quét.');
    return v;   // {u, t, q, e}
  }

  // ----- Google
  async token() {
    if (this.tok && Date.now() < this.hetTok) return this.tok;
    const luu = await this.state.storage.get('tok');           // giữ quyền Google qua các lần Cloudflare tắt/bật lại đối tượng
    if (luu && Date.now() < luu.het) { this.tok = luu.tok; this.hetTok = luu.het; return this.tok; }
    const sa = JSON.parse(String(this.env.GOOGLE_SA).trim());   // trim: bỏ ký tự BOM PowerShell chèn khi cất khoá
    const now = Math.floor(Date.now() / 1000);
    const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o))).replace(/=+$/, '');
    const dau = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
    const der = unb64(sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const ky = b64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(dau)))).replace(/=+$/, '');
    const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + dau + '.' + ky });
    const j = await r.json();
    if (!j.access_token) throw new Error('Không lấy được quyền Google: ' + (j.error_description || j.error || r.status));
    this.tok = j.access_token; this.hetTok = Date.now() + 50 * 60 * 1000;
    await this.state.storage.put('tok', { tok: this.tok, het: this.hetTok });
    return this.tok;
  }
  async g(path, opt) {
    const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + SHEET_ID + path,
      Object.assign({}, opt, { headers: { Authorization: 'Bearer ' + await this.token(), 'Content-Type': 'application/json' } }));
    const j = await r.json();
    if (!r.ok) throw new Error('Google Sheet báo lỗi: ' + ((j.error && j.error.message) || r.status));
    return j;
  }

  // ----- quét 1 mã: giống quetDon trong ChamCong.js
  async quetDon(p) {
    const t0 = Date.now();
    const v = await this.kiemVe(p.ve);
    const loai = p.loai === 'HOAN' ? 'HOAN' : 'DI';
    if ((v.q || []).indexOf(loai) < 0) return { ok: false, text: 'Bạn không có quyền quét ' + (loai === 'DI' ? 'đơn đi' : 'đơn hoàn') + '.' };
    const ma = chuanMaDon(p.ma);
    if (ma.length < 6) return { ok: false, text: 'Mã quá ngắn: ' + ma };
    if (loai === 'DI' && /^FUN/i.test(ma)) return { ok: true, chan: 'FUN', ma: ma };

    const tab = QDON[loai].tab;
    const t1 = Date.now(); await this.token(); const tQ = Date.now() - t1;
    const ranges = [q(tab) + '!A1:AZ'];
    if (loai === 'DI') ranges.push('DON_HUY!A2:E');
    else ranges.push(q(QDON.DI.tab) + '!A1:AZ');
    const bg = await this.g('/values:batchGet?valueRenderOption=FORMATTED_VALUE&' + ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&'));
    const tD = Date.now() - t1 - tQ;
    const all = bg.valueRanges[0].values || [[]];
    let h = all[0] || [];
    const rows = all.slice(1);
    const thieu = QDON[loai].them.filter(x => h.indexOf(x) < 0);
    if (thieu.length) {
      await this.g('/values/' + encodeURIComponent(q(tab) + '!' + cot(h.length + 1) + '1') + '?valueInputOption=RAW',
        { method: 'PUT', body: JSON.stringify({ values: [thieu] }) });
      h = h.concat(thieu);
    }
    const c = ten => h.indexOf(ten) + 1;
    const o = (r, ten) => (c(ten) ? String(r[c(ten) - 1] == null ? '' : r[c(ten) - 1]) : '');

    for (let i = rows.length - 1; i >= 0; i--) {
      if (o(rows[i], 'Mã vận đơn').trim().toUpperCase() !== ma) continue;
      const r = rows[i];
      return { ok: true, chan: 'TRUNG', ma: ma, luc: o(r, 'Ngày giờ quét'), ai: o(r, 'Người quét'), stt: o(r, 'STT'), tt: o(r, 'Trạng thái giao hàng') };
    }
    if (loai === 'DI') {
      for (const r of (bg.valueRanges[1].values || [])) {
        if (String(r[0] || '').trim().toUpperCase() === ma)
          return { ok: true, chan: 'HUY', ma: ma, maDon: r[1] || '', loaiHuy: r[2] || '', luc: r[3] || '', khach: r[4] || '' };
      }
    }
    const now = gioVN(), hn = now.ngay;
    const homNay = rows.filter(r => o(r, 'Ngày giờ quét').indexOf(hn) === 0);
    const dong = new Array(h.length).fill('');
    const dat = (ten, gt) => { if (c(ten)) dong[c(ten) - 1] = gt; };
    dat('ID', idNgauNhien());
    dat('Mã vận đơn', ma);
    dat('Ngày giờ quét', now.day);
    dat('Người quét', v.t);
    let stt = '';
    if (loai === 'DI') {           // STT đánh lại từ 1 mỗi ngày, chỉ tính dòng có Người quét
      stt = homNay.filter(r => o(r, 'Người quét')).reduce((m, r) => Math.max(m, Number(o(r, 'STT')) || 0), 0) + 1;
      dat('STT', stt);
      dat('Ngày quét', hn);
      dat('Trạng thái', 'Đơn đi');
    }
    // ghi ngay sau dòng cuối có dữ liệu (như appendRow)
    await this.g('/values/' + encodeURIComponent(q(tab) + '!A' + (all.length + 1)) + '?valueInputOption=USER_ENTERED',
      { method: 'PUT', body: JSON.stringify({ values: [dong] }) });
    const tG = Date.now() - t1 - tQ - tD;
    const kq = { ok: true, moi: true, ma: ma, stt: stt, gio: now.day.slice(11, 16), dem: homNay.length + 1, ai: v.t, nhanh: true,
      t: 'quyền ' + (tQ / 1000).toFixed(1) + ' · đọc ' + (tD / 1000).toFixed(1) + ' · ghi ' + (tG / 1000).toFixed(1) };
    if (loai === 'HOAN') {             // đối chiếu đơn đi (mã hoàn có thể khác ký tự cuối)
      const di = bg.valueRanges[1].values || [[]], hd = di[0] || [];
      const cMa = hd.indexOf('Mã vận đơn'), cNgay = hd.indexOf('Ngày quét'), cTt = hd.indexOf('Trạng thái giao hàng');
      for (let i = di.length - 1; i >= 1; i--) {
        const m2 = String(di[i][cMa] || '').trim().toUpperCase();
        if (m2 && (m2 === ma || (ma.length >= 16 && m2.slice(0, 16) === ma.slice(0, 16)))) {
          kq.donDi = { ngay: cNgay >= 0 ? di[i][cNgay] || '' : '', tt: cTt >= 0 ? di[i][cTt] || '' : '' };
          break;
        }
      }
    }
    kq.ms = Date.now() - t0;
    return kq;
  }
}

function q(tab) { return "'" + tab.replace(/'/g, "''") + "'"; }
function cot(n) { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function chuanMaDon(s) {
  s = String(s || '').trim().toUpperCase();
  const m = s.match(/SPXVN[0-9A-Z]{8,14}/) || s.match(/FUN\d{3,12}/);
  return m ? m[0] : s.replace(/\s+/g, '').slice(0, 60);
}
function idNgauNhien() { const k = 'abcdefghijklmnopqrstuvwxyz0123456789'; let t = ''; for (let i = 0; i < 8; i++) t += k[Math.floor(Math.random() * k.length)]; return t; }
function gioVN() {
  const d = new Date(Date.now() + 7 * 3600 * 1000), p = n => String(n).padStart(2, '0');
  const ngay = p(d.getUTCDate()) + '/' + p(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear();
  return { ngay: ngay, day: ngay + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) };
}
function b64url(u8) { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_'); }
function unb64(s) { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
function unb64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return unb64(s); }
