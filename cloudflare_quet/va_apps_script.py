# Thêm "vé" cho máy chủ nhanh vào quetTrangThai (ChamCong.js). Chạy 1 lần: python va_apps_script.py <đường dẫn ChamCong.js>
import sys
p = sys.argv[1]; s = open(p, encoding='utf-8').read()
if 'function taoVe(' in s: print('da va roi'); sys.exit(0)
a = "    const kq = { ok: true, ten: q.ten, quyen: q.quyen, homNay: {}, daCo: {}, huy: bangHuy(ss, true) };\n"
assert s.count(a) == 1, 'khong thay quetTrangThai'
s = s.replace(a, a + "    if (typeof VE_KHOA !== 'undefined' && VE_KHOA && typeof VE_URL !== 'undefined' && VE_URL) { kq.nhanh = VE_URL; kq.ve = taoVe(q); }\n")
b = "/** Trang mở: tên, quyền, đơn hôm nay"
assert s.count(b) == 1
s = s.replace(b, """/** vé cho máy chủ ghi nhanh (Cloudflare, cloudflare_quet/worker.js): {u, t, q, e} ký HMAC bằng VE_KHOA (file bi_mat_ve.js), hạn 12 giờ */
function taoVe(q) {
  const pl = Utilities.base64EncodeWebSafe(JSON.stringify({ u: String(q.u.id), t: q.ten, q: q.quyen, e: Date.now() + 12 * 3600 * 1000 }), Utilities.Charset.UTF_8);
  return pl + '.' + Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(pl, VE_KHOA));
}
""" + b)
open(p, 'w', encoding='utf-8', newline='').write(s)
print('ok')
