// 列印：標籤貼紙 4×3cm、發票機 57mm（藥局聯＋客戶聯）、A5、A4 清單。透過隱藏 iframe 列印，不影響主畫面。
import qrcode from 'qrcode-generator';
import { curStore, storeSetting, rocOf, mdOf, fullOf, fmtNo, maskPhone, dtOf, CIRCLED, ls, rpc, shortHosp, bridgeUrl, state, toast } from './lib.js';

// 版面為暫定，之後依實際紙張樣式調整
export const PRINT_MODES = [
  { id: 'label', name: '貼紙 4×3cm', short: '貼紙' },
  { id: 'r57', name: '發票紙 57mm', short: '57mm' },
  { id: 'a5', name: 'A5', short: 'A5' },
];
export const getPrintMode = () => { const m = ls.get('print_mode', 'label'); return PRINT_MODES.some(x => x.id === m) ? m : 'label'; };
export const setPrintMode = m => ls.set('print_mode', m);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  return qr.createSvgTag({ cellSize: 2, margin: 0, scalable: true });
}

function printHtml(html) {
  const f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true');
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open(); d.write(html); d.close();
  setTimeout(() => {
    try { f.contentWindow.focus(); f.contentWindow.print(); } finally { setTimeout(() => f.remove(), 2000); }
  }, 200);
}

const FONT = `"Microsoft JhengHei","PingFang TC","Noto Sans TC",sans-serif`;
const fillsActive = fills => (fills || []).filter(f => f.status !== 'cancelled').sort((a, b) => a.seq - b.seq);

// 貼紙 4×3cm：第一列姓名（依字數自動放到最大）；中間左 QR＋編號、右醫院/科別/電話/通知；粗線下方領藥日期
// 字級以 mm 計算：中文字寬 ≈ 1em、英數 ≈ 0.58em，依可用寬度自動縮放，避免超出貼紙
const textEm = t => [...String(t || '')].reduce((n, c) => n + (/[\x00-\xff]/.test(c) ? 0.58 : 1), 0);
const fit = (t, wMm, maxMm, minMm = 1.6) => Math.max(minMm, Math.min(maxMm, wMm / Math.max(1, textEm(t)))).toFixed(2);
function notifyText(m) {
  m = m || [];
  if (!m.length) return '';
  const n = m.filter(x => x !== '自取');
  return n.length ? n.join('/') + '通知' : '自取';
}
const SEQ_MARK = { 1: '➊', 2: '➋', 3: '➌' };
// 熱感機 203dpi、只能印純黑：Logo 用單色兩個圓（實心＋圓環），不用漸層、灰階與細線
const LOGO_MONO = `<svg viewBox="0 0 40 40" class="lg" aria-hidden="true"><circle cx="14.5" cy="24" r="10" fill="#000"/><circle cx="25.5" cy="15.5" r="8.6" fill="none" stroke="#fff" stroke-width="8"/><circle cx="25.5" cy="15.5" r="8.6" fill="none" stroke="#000" stroke-width="4.2"/></svg>`;
// 通知方式 → 外框標籤（LINE、簡訊、電話、自取）
const notifyTags = m => (m || []).map(x => `<span class="tg">${esc(x)}</span>`).join('');
function labelHtml(o, fills) {
  const fs = fillsActive(fills);
  const RW = 19;                                        // 右側文字欄寬度
  // 右側固定四列（高度固定，不受字型行高影響）：醫院、科別、通知方式、電話；沒有資料的列留白
  const row = (k, t, mx) => `<div class="r ${k}"><span style="font-size:${t ? fit(t, RW, mx) : mx}mm">${t ? esc(t) : ''}</span></div>`;
  const tags = notifyTags(o.notify_methods);
  const info = row('h', shortHosp(o.hospital_code, o.hospital_name), 3.1) + row('d', o.dept_name, 3.1)
    + `<div class="r tgs">${tags}</div>` + row('p', o.phone, 3.5);
  // 領藥日：只印月/日，序號用 ➊➋➌；一次排一列，次數越少字越大
  const dsz = fs.length >= 3 ? 3.7 : fs.length === 2 ? 5.2 : 6;
  const fl = fs.map(f => `<span><b>${SEQ_MARK[f.seq] || f.seq}</b>${mdOf(f.due_date)}</span>`).join('');
  return `<div class="lb">
    <div class="hd"><div class="hl">${LOGO_MONO}<span class="cp">藥局聯</span></div><div class="nm" style="font-size:${fit(o.patient_name, 20.8, 5.6)}mm">${esc(o.patient_name)}</div></div>
    <div class="mid">
      <div class="qrw"><div class="qr">${qrSvg(o.order_no)}</div><div class="no">${esc(fmtNo(o.order_no))}</div></div>
      <div class="info">${info}</div>
    </div>
    <div class="fl" style="font-size:${dsz}mm">${fl}</div>
  </div>`;
}

// 民國年月日 時:分（例 115/11/17 20:48）
const rocDT = ts => {
  const d = new Date(ts || Date.now()); const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear() - 1911}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};
// 單據共用區塊（57mm 與 A5 同一套版面，A5 只是放大）
function slipParts(o) {
  const store = esc(curStore()?.name || '');
  const head = copy => `<div class="top">${LOGO_MONO}<div class="sn"><div class="s1">${store}</div><div class="s2">慢性處方箋寄單</div></div><div class="cp">${copy}</div></div>`;
  const id = `<div class="id"><div class="qr">${qrSvg(o.order_no)}</div><div class="it">
      <div class="no">${esc(fmtNo(o.order_no))}</div>
      <div>${esc(shortHosp(o.hospital_code, o.hospital_name) || o.hospital_name || '')}</div>
      <div>${esc(o.dept_name || '')}</div></div></div>`;
  const contact = `<div class="ct">${notifyTags(o.notify_methods)}<span class="ph">${o.phone ? esc(o.phone) : '&nbsp;'}</span></div>`;
  const meta = `<div class="meta"><span>${rocDT(o.created_at)}</span>${o.created_staff_code ? `<span>輸入人員：${esc(o.created_staff_code)}</span>` : ''}</div>`;
  const msg = `<div class="msg">藥品準備完成後會通知您。<br>請於接到通知後10天內，攜帶<br>「健保卡」來藥局領藥！</div>
    <div class="tips"><div>☀ 建議收到通知後，再來藥局領藥。</div><div>☀ 領藥時出示本單據可加快現場作業。</div></div>`;
  const ft = storeSetting('receipt_footer', '');
  const footer = ft ? `<div class="ft">${esc(ft)}</div>` : '';
  const dates = (fs, hl) => fs.map(f => `<div class="d${f.seq === hl ? ' hl' : ''}"><b>${SEQ_MARK[f.seq] || f.seq}</b>${fullOf(f.due_date)}</div>`).join('')
    || '<div class="d">（未排定）</div>';
  return { head, id, contact, meta, msg, footer, dates };
}
// 57mm：每一次領藥各印一張「藥局聯」（該次日期反黑，跟著該次藥袋），最後一張「客戶聯」；每張一頁，發票機自動裁切
function receiptHtml(o, fills) {
  const fs = fillsActive(fills);
  const P = slipParts(o);
  const nm = `<div class="nm">${esc(o.patient_name)}</div>`;
  const note = o.note ? `<div class="note">${esc(o.note)}</div>` : '';
  const shop = (fs.length ? fs : [{ seq: 0 }]).map(f => `<div class="pg">
    ${P.head('藥局聯')}${nm}${P.id}<hr>
    ${P.contact}
    <div class="ds">${P.dates(fs, f.seq)}</div>${note}
    <hr>${P.meta}
  </div>`).join('');
  const cust = `<div class="pg">
    ${P.head('客戶聯')}${nm}${P.id}<hr>
    <div class="lbl">預計領藥時間</div>
    <div class="ds">${P.dates(fs, 0)}</div>
    ${P.msg}${P.footer}
    <hr>${P.meta}
  </div>`;
  return shop + cust;
}

// A5：與 57mm 同一風格，一張紙放完整資料（電話、通知、預計領藥時間、提醒）
function a5Html(o, fills) {
  const fs = fillsActive(fills);
  const P = slipParts(o);
  return `<div class="pg a5">
    ${P.head('寄單單據')}
    <div class="nm">${esc(o.patient_name)}${o.birth_date ? `<small>${fullOf(o.birth_date)}</small>` : ''}</div>
    ${P.id}<hr>
    ${P.contact}<hr>
    <div class="lbl">預計領藥時間</div>
    <div class="ds">${P.dates(fs, 0)}</div>
    ${o.note ? `<div class="note">備註：${esc(o.note)}</div>` : ''}
    ${P.msg}${P.footer}
    <hr>${P.meta}
  </div>`;
}

// 57mm 與 A5 共用的版面樣式（尺寸用 CSS 變數，各自設定）
const SLIP = `
    .top{display:flex;align-items:center;gap:var(--g);padding-bottom:var(--g);border-bottom:var(--b2) solid #000}
    .lg{width:var(--lg);height:var(--lg);flex:none}
    .sn{flex:1;min-width:0;line-height:1.15}.s1{font-size:var(--f2);font-weight:900;white-space:nowrap}.s2{font-size:var(--f4);font-weight:700;white-space:nowrap}
    .cp{flex:none;background:#000;color:#fff;font-size:var(--f3);font-weight:900;padding:.15em .5em;border-radius:.25em}
    .nm{font-size:var(--f1);font-weight:900;line-height:1.2;margin:var(--g) 0 calc(var(--g) * .6);word-break:break-all}
    .nm small{font-size:var(--f3);font-weight:700;margin-left:.6em;font-family:Arial,sans-serif}
    .id{display:flex;align-items:center;gap:calc(var(--g) * 1.4)}
    .qr{width:var(--qr);height:var(--qr);flex:none}.qr svg{width:100%;height:100%;display:block}
    .it{min-width:0;font-size:var(--f3);line-height:1.45;font-weight:500}
    .it .no{font-family:Arial,sans-serif;font-weight:700}
    hr{border:0;border-top:var(--b1) solid #000;margin:calc(var(--g) * 1.2) 0}
    .ct{display:flex;align-items:center;gap:calc(var(--g) * 1.2);flex-wrap:wrap;min-height:calc(var(--f2) * 1.6)}
    .tg{border:var(--b1) solid #000;border-radius:.2em;padding:0 .3em;font-size:var(--f2);font-weight:700;font-family:Arial,${FONT};line-height:1.3}
    .ph{font-size:var(--f2);font-weight:700;font-family:Arial,sans-serif}
    .lbl{font-size:var(--f3);font-weight:900}
    .ds{margin-top:calc(var(--g) * .8)}
    .d{display:flex;align-items:center;gap:.3em;font-size:var(--fd);font-weight:500;font-family:Arial,"Helvetica Neue",sans-serif;line-height:1.3;padding:.04em .2em;margin:.06em 0;border-radius:.12em}
    .d b{font-family:"Segoe UI Symbol","Microsoft JhengHei","Noto Sans Symbols 2","DejaVu Sans",sans-serif;font-weight:400;font-size:.7em;line-height:1}
    .d.hl{background:#000;color:#fff;font-weight:700}
    .note{margin-top:var(--g);font-size:var(--f3);font-weight:700;word-break:break-all}
    .msg{margin-top:calc(var(--g) * 1.2);background:#000;color:#fff;text-align:center;font-size:var(--fm);white-space:nowrap;font-weight:900;line-height:1.45;padding:.5em .4em;border-radius:.35em}
    .tips{margin-top:var(--g);font-size:var(--ft);font-weight:500;line-height:1.7;white-space:nowrap}
    .ft{margin-top:calc(var(--g) * .6);font-size:var(--f4);font-weight:700}
    .pg:last-child{break-after:auto;page-break-after:auto}
    .meta{display:flex;align-items:baseline;gap:1.2em;font-size:var(--f4);font-family:Arial,${FONT}}`;

const CSS = {
  label: `@page{size:40mm 30mm;margin:0}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
    html,body{margin:0;padding:0;font-family:${FONT};color:#000}
    .lb{width:40mm;height:30mm;padding:1mm 1.5mm .6mm;display:flex;flex-direction:column;break-after:page;page-break-after:always;overflow:hidden}
    .lb:last-child{break-after:auto;page-break-after:auto}
    .hd{display:flex;align-items:center;gap:1.6mm;height:6.6mm;flex:none}
    .hd .hl{flex:none;width:13mm;margin-right:.4mm;display:flex;align-items:center;justify-content:space-between}
    .hd .lg{width:5.4mm;height:5.4mm;flex:none}
    .hd .cp{flex:none;background:#000;color:#fff;font-size:2.3mm;font-weight:700;padding:.5mm .6mm;border-radius:.6mm;line-height:1.1}
    .hd .nm{flex:1;min-width:0;font-weight:900;white-space:nowrap;overflow:hidden;line-height:1}
    .mid{display:flex;gap:1.6mm;align-items:flex-start;height:15.6mm;flex:none;overflow:hidden}
    .qrw{flex:none;width:13.4mm;text-align:center;padding-top:.2mm}
    .qr{width:12.6mm;height:12.6mm;margin:0 auto}.qr svg{width:100%;height:100%;display:block}
    .no{font-size:1.95mm;font-family:Arial,sans-serif;margin-top:.3mm;white-space:nowrap;letter-spacing:-.03mm}
    .info{min-width:0;flex:1;font-weight:400}
    .r{display:flex;align-items:center;white-space:nowrap;overflow:hidden;line-height:1}
    .r.h,.r.d{height:3.6mm}.r.tgs{height:4.6mm;gap:.8mm;overflow:visible;padding-left:.2mm}.r.p{height:3.8mm}
    .r.p{font-family:Arial,sans-serif;letter-spacing:-.02mm}
    .tg{border:.3mm solid #000;border-radius:.6mm;padding:.25mm .7mm;font-size:2.5mm;font-weight:700;font-family:Arial,${FONT};line-height:1}
    .fl{border-top:.3mm solid #000;flex:1;min-height:0;font-family:Arial,${FONT};font-weight:700;
      display:flex;align-items:center;justify-content:space-around;white-space:nowrap;line-height:1;overflow:hidden}
    .fl span{display:flex;align-items:center}
    .fl b{font-family:"Segoe UI Symbol","Microsoft JhengHei","Noto Sans Symbols 2","DejaVu Sans",sans-serif;font-weight:400;
      font-size:.72em;line-height:1;margin-right:.2em}`,
  // 57mm 發票紙（可印寬度約 48mm）；只用純黑，不用灰色
  // 靠左排、寬 46mm：發票機的可列印範圍從紙張左邊算起，置中的話紙張設定偏寬時會整個往右跑、右邊被切掉
  receipt: `@page{margin:0}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
    html,body{margin:0;padding:0;font-family:${FONT};color:#000;background:#fff}
    .pg{--f1:17pt;--f2:12.5pt;--f3:10.5pt;--f4:8.5pt;--fd:20pt;--fm:9.3pt;--ft:7.6pt;--g:1.6mm;--b1:.3mm;--b2:.6mm;--lg:7.5mm;--qr:14mm;
      width:46mm;margin:0;padding:2mm 0 6mm 1mm;break-after:page;page-break-after:always}${SLIP}`,
  // A5：同一風格放大
  a5: `@page{size:A5;margin:9mm 10mm}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
    html,body{margin:0;padding:0;font-family:${FONT};color:#000;background:#fff}
    .pg{--f1:24pt;--f2:15pt;--f3:12.5pt;--f4:10pt;--fd:24pt;--fm:13.5pt;--ft:10.5pt;--g:2.6mm;--b1:.4mm;--b2:.8mm;--lg:11mm;--qr:26mm;
      height:191mm;overflow:hidden;break-after:page;page-break-after:always}${SLIP}`,
};

/** 列印寄單（mode 省略則用本機設定） */
/** 貼紙要印的內容（與調劑系統 rx_intake 回傳的 label 格式相同），交給 RxBridge 直接列印 */
export function labelData(o, fills) {
  return {
    order_no: o.order_no, order_no_fmt: fmtNo(o.order_no), patient_name: o.patient_name || '',
    hospital: shortHosp(o.hospital_code, o.hospital_name) || '', dept: o.dept_name || '', phone: o.phone || '',
    notify: notifyText(o.notify_methods), notify_methods: o.notify_methods || [],
    fills: fillsActive(fills).map(f => ({ seq: f.seq, md: mdOf(f.due_date) })),
  };
}
/** 4×3 貼紙優先送本機 RxBridge 列印（可指定印表機、不跳視窗）；RxBridge 沒開或失敗時改用瀏覽器列印 */
async function printLabelViaBridge(o, fills, copies) {
  const u = bridgeUrl();
  if (!u || !storeSetting('bridge_print', true)) return false;
  try {
    const r = await fetch(u + '/print-label', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: labelData(o, fills), copies }), signal: AbortSignal.timeout(6000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || r.status);
    toast(`已送出貼紙列印（${j.printer || 'RxBridge'}）`, 'ok', 1500);
    return true;
  } catch (e) {
    toast('RxBridge 列印失敗，改用瀏覽器列印：' + (e.message || e), 'warn', 3500);
    return false;
  }
}

export async function printOrder(o, fills, mode = getPrintMode(), copies = 1) {
  if (o.id) rpc('rx_log_print', { p_id: o.id, p_mode: mode }).catch(() => {});
  if (mode === 'label' && state.bridge !== 'off' && await printLabelViaBridge(o, fills, copies)) return;
  const one = mode === 'label' ? labelHtml(o, fills) : mode === 'a5' ? a5Html(o, fills) : receiptHtml(o, fills);
  const css = mode === 'label' ? CSS.label : mode === 'a5' ? CSS.a5 : CSS.receipt;
  const body = Array.from({ length: Math.max(1, copies) }, () => one).join('');
  printHtml(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
}

/** A4 清單列印（預作未確認清單等） */
export function printList(title, cols, rows) {
  const th = cols.map(c => `<th>${esc(c.label)}</th>`).join('');
  const tr = rows.map(r => `<tr>${cols.map(c => `<td>${esc(typeof c.get === 'function' ? c.get(r) : r[c.key])}</td>`).join('')}</tr>`).join('');
  printHtml(`<!doctype html><html><head><meta charset="utf-8"><style>
    @page{size:A4;margin:12mm}body{font-family:${FONT};font-size:10.5pt;color:#000}
    h1{font-size:15pt;margin:0 0 2mm}.sub{font-size:9pt;margin-bottom:4mm}
    table{width:100%;border-collapse:collapse}th,td{border:.2mm solid #666;padding:1.4mm 2mm;text-align:left}
    th{background:#eee}td.ck{width:8mm}
  </style></head><body><h1>${esc(title)}</h1>
  <div class="sub">${esc(curStore()?.name || '')} · 列印時間 ${dtOf(new Date())} · 共 ${rows.length} 筆</div>
  <table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></body></html>`);
}