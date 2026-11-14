// 列印：標籤貼紙 4×3cm、發票機 80/58mm、A4 清單。透過隱藏 iframe 列印，不影響主畫面。
import qrcode from 'qrcode-generator';
import { curStore, storeSetting, rocOf, mdOf, fullOf, fmtNo, maskPhone, dtOf, CIRCLED, ls, rpc, shortHosp } from './lib.js';

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
function labelHtml(o, fills) {
  const fs = fillsActive(fills);
  const W = 37;                                         // 可用寬度（40mm − 左右邊界）
  const RW = 21.5;                                      // 右側文字欄寬度
  const lines = [
    ['h', shortHosp(o.hospital_code, o.hospital_name)],
    ['d', o.dept_name],
    ['p', o.phone],
    ['n', notifyText(o.notify_methods)],
  ].filter(x => x[1]);
  const lineMax = lines.length <= 3 ? 3.5 : 3.1;
  const info = lines.map(([k, t]) => `<div class="${k}" style="font-size:${fit(t, RW, lineMax)}mm">${esc(t)}</div>`).join('');
  // 領藥日：序號用黑框圈（不靠底色，熱感印表機也印得出來）
  const each = fs.length ? W / fs.length : W;
  const dsz = Math.min(6, (each - 0.6) / 3.35).toFixed(2);
  const fl = fs.map(f => `<span><b>${f.seq}</b>${mdOf(f.due_date)}</span>`).join('');
  return `<div class="lb">
    <div class="nm" style="font-size:${fit(o.patient_name, W, 6.2)}mm">${esc(o.patient_name)}</div>
    <div class="mid">
      <div class="qrw"><div class="qr">${qrSvg(o.order_no)}</div><div class="no">${esc(fmtNo(o.order_no))}</div></div>
      <div class="info">${info}</div>
    </div>
    <div class="fl${fs.length === 1 ? ' one' : ''}" style="font-size:${dsz}mm">${fl}</div>
  </div>`;
}

function receiptHtml(o, fills, w) {
  const rows = fillsActive(fills).map(f => `<tr><td>第${f.seq}次</td><td class="r">${rocOf(f.due_date, true)}</td></tr>`).join('');
  return `<div class="rc" style="width:${w}mm">
    <div class="st">${esc(curStore()?.name || '')}</div>
    <div class="tt">慢性處方箋寄單</div>
    <div class="qr">${qrSvg(o.order_no)}</div>
    <div class="no">${esc(fmtNo(o.order_no))}</div>
    <table>
      <tr><td>姓名</td><td class="r b">${esc(o.patient_name)}</td></tr>
      ${o.birth_date ? `<tr><td>生日</td><td class="r">${fullOf(o.birth_date)}</td></tr>` : ''}
      ${o.phone ? `<tr><td>電話</td><td class="r">${esc(maskPhone(o.phone))}</td></tr>` : ''}
      <tr><td>通知</td><td class="r">${esc((o.notify_methods || []).join('、'))}</td></tr>
      ${o.hospital_name ? `<tr><td>醫院</td><td class="r">${esc(shortHosp(o.hospital_code, o.hospital_name))}</td></tr>` : ''}
      ${o.dept_name ? `<tr><td>科別</td><td class="r">${esc(o.dept_name)}</td></tr>` : ''}
    </table>
    <div class="hd">領藥日期</div>
    <table class="fl">${rows}</table>
    ${o.note ? `<div class="nt">備註：${esc(o.note)}</div>` : ''}
    <div class="ft">寄單時間 ${dtOf(o.created_at || new Date())}${o.created_staff_name ? ' · ' + esc(o.created_staff_name) : ''}</div>
    <div class="ft">${esc(storeSetting('receipt_footer', ''))}</div>
  </div>`;
}

function a5Html(o, fills) {
  const rows = fillsActive(fills).map(f => `<tr><td>第 ${f.seq} 次</td><td class="r">${rocOf(f.due_date, true)}</td><td class="ck"></td></tr>`).join('');
  return `<div class="a5">
    <div class="hd"><div><div class="st">${esc(curStore()?.name || '')}</div><div class="tt">慢性處方箋寄單</div></div>
      <div class="qr">${qrSvg(o.order_no)}</div></div>
    <div class="no">寄單編號 ${esc(fmtNo(o.order_no))}</div>
    <table class="info">
      <tr><th>姓名</th><td class="b">${esc(o.patient_name)}</td><th>生日</th><td>${o.birth_date ? fullOf(o.birth_date) : ''}</td></tr>
      <tr><th>電話</th><td>${esc(o.phone || '')}</td><th>通知</th><td>${esc((o.notify_methods || []).join('、'))}</td></tr>
      <tr><th>醫院</th><td colspan="3">${esc(o.hospital_name || '')}</td></tr>
      <tr><th>科別</th><td colspan="3" class="b">${esc(o.dept_name || '')}</td></tr>
    </table>
    <table class="fl"><tr><th>次數</th><th class="r">領藥日</th><th>預作確認</th></tr>${rows}</table>
    ${o.note ? `<div class="nt">備註：${esc(o.note)}</div>` : ''}
    <div class="ft">寄單時間 ${dtOf(o.created_at || new Date())}${o.created_staff_name ? ' · ' + esc(o.created_staff_name) : ''}　${esc(storeSetting('receipt_footer', ''))}</div>
  </div>`;
}

const CSS = {
  label: `@page{size:40mm 30mm;margin:0}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    html,body{margin:0;padding:0;font-family:${FONT};color:#000}
    .lb{width:40mm;height:30mm;padding:1mm 1.5mm .8mm;box-sizing:border-box;display:flex;flex-direction:column;page-break-after:always;overflow:hidden}
    .nm{font-weight:900;white-space:nowrap;overflow:hidden;line-height:1.08;letter-spacing:0}
    .mid{display:flex;gap:1.6mm;align-items:center;margin-top:.5mm}
    .qrw{flex:none;width:12.6mm;text-align:center;background:#fff}
    .qr{width:12.6mm;height:12.6mm}.qr svg{width:100%;height:100%;display:block}
    .no{font-size:1.5mm;font-family:Arial,sans-serif;margin-top:.3mm;white-space:nowrap;letter-spacing:-.05mm}
    .info{min-width:0;flex:1;line-height:1.15;font-weight:700}
    .info>div{white-space:nowrap;overflow:hidden}
    .info .p{font-family:Arial,sans-serif;font-weight:900;letter-spacing:-.05mm}
    .fl{margin-top:auto;border-top:.55mm solid #000;padding-top:.4mm;font-weight:900;font-family:Arial,${FONT};
      display:flex;justify-content:space-between;white-space:nowrap;line-height:1.05;letter-spacing:-.04em}
    .fl.one{justify-content:center}
    .fl span{display:flex;align-items:center}
    .fl b{display:inline-grid;place-items:center;width:1.05em;height:1.05em;font-size:.66em;border:.35mm solid #000;border-radius:50%;
      color:#000;margin-right:.12em;letter-spacing:0;box-sizing:border-box}`,
  receipt: `@page{margin:0}
    html,body{margin:0;padding:0;font-family:${FONT};color:#000}
    .rc{padding:3mm 2mm 6mm;box-sizing:border-box;font-size:10pt;page-break-after:always}
    .st{text-align:center;font-size:12pt;font-weight:900}
    .tt{text-align:center;font-size:10pt;margin-bottom:2mm}
    .qr{width:26mm;height:26mm;margin:0 auto}.qr svg{width:100%;height:100%;display:block}
    .no{text-align:center;font-size:12pt;font-weight:900;font-family:Arial,sans-serif;letter-spacing:.5px;margin:1mm 0 2mm}
    table{width:100%;border-collapse:collapse}td{padding:.4mm 0;vertical-align:top}td:first-child{white-space:nowrap;width:10mm;padding-right:2mm}.r{text-align:right}.b{font-weight:900;font-size:12pt}
    .hd{border-top:.3mm dashed #000;margin-top:2mm;padding-top:1.5mm;font-weight:900}
    .fl td{font-size:11pt;font-weight:700}
    .nt{margin-top:2mm;font-size:9pt}
    .ft{margin-top:2mm;font-size:8pt;text-align:center}`,
  a5: `@page{size:A5;margin:10mm}
    html,body{margin:0;font-family:${FONT};color:#000;font-size:12pt}
    .a5{page-break-after:always}
    .hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:.5mm solid #000;padding-bottom:3mm}
    .st{font-size:16pt;font-weight:900}.tt{font-size:12pt}
    .qr{width:28mm;height:28mm}.qr svg{width:100%;height:100%;display:block}
    .no{font-family:Arial,sans-serif;font-size:14pt;font-weight:900;margin:3mm 0}
    table{width:100%;border-collapse:collapse;margin-top:2mm}
    th,td{border:.25mm solid #555;padding:2mm 2.5mm;text-align:left;vertical-align:top}
    th{background:#eee;width:16mm;white-space:nowrap}.b{font-weight:900;font-size:14pt}.r{text-align:right}
    .fl td{font-size:14pt;font-weight:700}.fl td.ck{width:30mm}
    .nt{margin-top:3mm}.ft{margin-top:4mm;font-size:9pt;color:#333}`,
};

/** 列印寄單（mode 省略則用本機設定） */
export function printOrder(o, fills, mode = getPrintMode(), copies = 1) {
  const one = mode === 'label' ? labelHtml(o, fills) : mode === 'a5' ? a5Html(o, fills) : receiptHtml(o, fills, 50);
  const css = mode === 'label' ? CSS.label : mode === 'a5' ? CSS.a5 : CSS.receipt;
  const body = Array.from({ length: Math.max(1, copies) }, () => one).join('');
  printHtml(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
  if (o.id) rpc('rx_log_print', { p_id: o.id, p_mode: mode }).catch(() => {});
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