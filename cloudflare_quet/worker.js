// Ghi đơn quét nhanh vào Google Sheet "Danh Sách ĐH" (thay bước ghi qua Apps Script): lưu kho Cloudflare trước, trả lời ngay, ghi Sheet ngầm.
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
  // Kho tạm: bản sao Sheet trong bộ nhớ (đọc lại sau mỗi lần ghi, hoặc khi cũ hơn 60s) + hàng chờ ghi cất trong ổ của Cloudflare.
  // Quét: đối chiếu với kho, cất vào hàng chờ, trả lời ngay; ghi Sheet chạy ngầm ngay sau đó (lỗi thì 30s thử lại).
  constructor(state, env) { this.state = state; this.env = env; this.tok = null; this.hetTok = 0; this.xep = Promise.resolve();
    this.kho = null; this.cho = null; this.dayP = null; }
  async fetch(req) {
    let p;
    try { p = await req.json(); } catch (e) { return json({ ok: false, text: 'Dữ liệu gửi lên không đọc được.' }); }
    const viec = this.xep.then(() => p.xoa ? this.xoaDon(p) : p.trangThai ? this.trangThai(p) : this.quetDon(p));
    this.xep = viec.catch(() => {});
    try { return json(await viec); } catch (e) { return json({ ok: false, text: String(e.message || e), loiMay: true }); }
  }
  async alarm() { await this.napCho(); if (this.cho.length) await this.day(); }

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

  // ----- kho: đọc 3 bảng trong 1 lần gọi
  async docSheet() {
    const ranges = [q(QDON.DI.tab) + '!A1:AZ', q(QDON.HOAN.tab) + '!A1:AZ', 'DON_HUY!A2:E'];
    const bg = await this.g('/values:batchGet?valueRenderOption=FORMATTED_VALUE&' + ranges.map(r => 'ranges=' + encodeURIComponent(r)).join('&'));
    const bang = i => { const all = bg.valueRanges[i].values || [[]]; return { h: all[0] || [], rows: all.slice(1), soDong: all.length }; };
    return { luc: Date.now(), DI: bang(0), HOAN: bang(1), huy: bg.valueRanges[2].values || [] };
  }
  async napCho() { if (!this.cho) this.cho = (await this.state.storage.get('cho')) || []; }
  async catCho() {
    await this.state.storage.put('cho', this.cho);
    if (this.cho.length && !(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now() + 30000);
  }
  // dòng của bảng (mảng theo tiêu đề) hoặc của hàng chờ (đối tượng) -> đọc theo tên cột
  doc(b, r, ten) { if (!Array.isArray(r)) return r[ten] == null ? '' : String(r[ten]); const i = b.h.indexOf(ten); return i < 0 || r[i] == null ? '' : String(r[i]); }
  dsDong(loai) { const b = this.kho[loai]; return b.rows.concat(this.cho.filter(x => x.loai === loai).map(x => x.o)); }

  // ----- ghi hàng chờ lên Sheet (chạy ngầm, mỗi lúc 1 lượt)
  day() {
    if (this.dayP) { this.dayLai = true; return this.dayP; }
    this.dayP = (async () => {
      try { do { this.dayLai = false; await this.dayMot(); } while (this.dayLai); }
      catch (e) { this.loiDay = String(e.message || e); try { await this.state.storage.setAlarm(Date.now() + 30000); } catch (e2) {} }
      finally { this.dayP = null; }
    })();
    return this.dayP;
  }
  async dayMot() {
    await this.napCho();
    const lo = this.cho.slice();                     // lượt này ghi những mã đang chờ lúc bắt đầu
    const moi = await this.docSheet();
    for (const loai of ['DI', 'HOAN']) {
      const b = moi[loai], tab = QDON[loai].tab;
      const thieu = QDON[loai].them.filter(x => b.h.indexOf(x) < 0);
      const co = new Set(b.rows.map(r => this.doc(b, r, 'Mã vận đơn').trim().toUpperCase()));
      const ghi = lo.filter(x => x.loai === loai && !co.has(x.ma));   // đã có trên Sheet (vd. ghi qua Apps Script) thì thôi
      if (!ghi.length) continue;
      if (thieu.length) {
        await this.g('/values/' + encodeURIComponent(q(tab) + '!' + cot(b.h.length + 1) + '1') + '?valueInputOption=RAW',
          { method: 'PUT', body: JSON.stringify({ values: [thieu] }) });
        b.h = b.h.concat(thieu);
      }
      const dong = ghi.map(x => b.h.map(ten => x.o[ten] == null ? '' : x.o[ten]));
      await this.g('/values/' + encodeURIComponent(q(tab) + '!A' + (b.soDong + 1)) + '?valueInputOption=USER_ENTERED',
        { method: 'PUT', body: JSON.stringify({ values: dong }) });
      b.rows = b.rows.concat(dong); b.soDong += dong.length;
    }
    const xong = new Set(lo.map(x => x.id));
    this.cho = this.cho.filter(x => !xong.has(x.id));
    await this.catCho();
    this.kho = moi; this.loiDay = '';
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

    await this.napCho();
    let tD = 0;
    if (!this.kho || Date.now() - this.kho.luc > 60000) {      // kho cũ (nghỉ quét >1 phút) -> đọc lại Sheet trước
      const t1 = Date.now();
      try { this.kho = await this.docSheet(); } catch (e) { if (!this.kho) throw e; }
      tD = Date.now() - t1;
    }
    const b = this.kho[loai], o = (r, ten) => this.doc(b, r, ten);
    const ds = this.dsDong(loai);
    for (let i = ds.length - 1; i >= 0; i--) {
      if (o(ds[i], 'Mã vận đơn').trim().toUpperCase() !== ma) continue;
      const r = ds[i];
      return { ok: true, chan: 'TRUNG', ma: ma, luc: o(r, 'Ngày giờ quét'), ai: o(r, 'Người quét'), stt: o(r, 'STT'), tt: o(r, 'Trạng thái giao hàng') };
    }
    if (loai === 'DI') {
      for (const r of this.kho.huy) {
        if (String(r[0] || '').trim().toUpperCase() === ma)
          return { ok: true, chan: 'HUY', ma: ma, maDon: r[1] || '', loaiHuy: r[2] || '', luc: r[3] || '', khach: r[4] || '' };
      }
    }
    const now = gioVN(), hn = now.ngay;
    const homNay = ds.filter(r => o(r, 'Ngày giờ quét').indexOf(hn) === 0);
    const dong = { 'ID': idNgauNhien(), 'Mã vận đơn': ma, 'Ngày giờ quét': now.day, 'Người quét': v.t };
    let stt = '';
    if (loai === 'DI') {           // STT đánh lại từ 1 mỗi ngày, chỉ tính dòng có Người quét
      stt = homNay.filter(r => o(r, 'Người quét')).reduce((m, r) => Math.max(m, Number(o(r, 'STT')) || 0), 0) + 1;
      Object.assign(dong, { 'STT': stt, 'Ngày quét': hn, 'Trạng thái': 'Đơn đi' });
    }
    this.cho.push({ id: dong.ID, loai: loai, ma: ma, o: dong });
    await this.catCho();                                       // đã cất vào ổ Cloudflare -> mất kết nối Google vẫn không mất đơn
    this.day();                                                // ghi Sheet ngầm, không chờ
    const kq = { ok: true, moi: true, ma: ma, stt: stt, gio: now.day.slice(11, 16), dem: homNay.length + 1, ai: v.t, nhanh: true,
      t: (tD ? 'đọc Sheet ' + (tD / 1000).toFixed(1) + ' · ' : '') + 'lên Sheet sau vài giây' + (this.cho.length > 1 ? ' · ' + this.cho.length + ' đang chờ' : '') + (this.loiDay ? ' · lần ghi trước lỗi: ' + this.loiDay : '') };
    if (loai === 'HOAN') {             // đối chiếu đơn đi (mã hoàn có thể khác ký tự cuối)
      const bd = this.kho.DI, di = this.dsDong('DI');
      for (let i = di.length - 1; i >= 0; i--) {
        const m2 = this.doc(bd, di[i], 'Mã vận đơn').trim().toUpperCase();
        if (m2 && (m2 === ma || (ma.length >= 16 && m2.slice(0, 16) === ma.slice(0, 16)))) {
          kq.donDi = { ngay: this.doc(bd, di[i], 'Ngày quét'), tt: this.doc(bd, di[i], 'Trạng thái giao hàng') };
          break;
        }
      }
    }
    kq.ms = Date.now() - t0;
    return kq;
  }

  // ----- mở trang: danh sách hôm nay + mã đã có + đơn hủy, lấy từ kho (giống quetTrangThai trong ChamCong.js)
  async trangThai(p) {
    const v = await this.kiemVe(p.ve);
    if (!(v.q || []).length) return { ok: false, loi: 'Bạn chưa được cấp quyền quét đơn.' };
    await this.napCho();
    if (!this.kho || Date.now() - this.kho.luc > 60000) this.kho = await this.docSheet();
    const hn = gioVN().ngay, kq = { ok: true, ten: v.t, quyen: v.q, u: v.u, homNay: {}, daCo: {}, huy: {}, nhanh: true };
    for (const r of this.kho.huy) { const k = String(r[0] || '').trim().toUpperCase(); if (k) kq.huy[k] = { maDon: r[1] || '', loai: r[2] || '', luc: r[3] || '', khach: r[4] || '' }; }
    for (const l of v.q) {
      const b = this.kho[l], o = (r, ten) => this.doc(b, r, ten), ds = this.dsDong(l);
      kq.daCo[l] = ds.map(r => o(r, 'Mã vận đơn').trim().toUpperCase()).filter(String);
      kq.homNay[l] = ds.filter(r => o(r, 'Ngày giờ quét').indexOf(hn) === 0).map(r => ({ ma: o(r, 'Mã vận đơn'), stt: o(r, 'STT'),
        gio: o(r, 'Ngày giờ quét').slice(11, 16), ai: o(r, 'Người quét'), anh: o(r, 'Ảnh') ? o(r, 'Ảnh').split('\n').length : 0,
        tinh: o(r, 'Tình trạng hàng'), lyDo: o(r, 'Lý do') }));
    }
    return kq;
  }

  // ----- nút Xóa trên trang: mã còn trong hàng chờ thì bỏ luôn ở đây; đã lên Sheet thì trang xoá tiếp qua Apps Script
  async xoaDon(p) {
    const v = await this.kiemVe(p.ve);
    const loai = p.loai === 'HOAN' ? 'HOAN' : 'DI', ma = chuanMaDon(p.ma);
    while (this.dayP) await this.dayP;                         // đang ghi dở thì đợi ghi xong, tránh xoá hụt
    await this.napCho();
    const n = this.cho.length;
    this.cho = this.cho.filter(x => !(x.loai === loai && x.ma === ma && x.o['Người quét'] === v.t));
    if (this.cho.length < n) { await this.catCho(); return { ok: true, xongHang: true }; }
    if (this.kho) { const b = this.kho[loai]; b.rows = b.rows.filter(r => this.doc(b, r, 'Mã vận đơn').trim().toUpperCase() !== ma); }
    return { ok: true, xongHang: false };
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
