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

// 貼紙 4×3cm：上方姓名、電話、通知、醫院、科別＋QR；下方領藥日期放大
function labelHtml(o, fills) {
  const fs = fillsActive(fills);
  const size = fs.length <= 1 ? 20 : fs.length === 2 ? 15 : 10.5;
  const fl = fs.map(f => `<span><i>${f.seq}</i>${mdOf(f.due_date)}</span>`).join('');
  return `<div class="lb">
    <div class="top">
      <div class="info">
        <div class="nm">${esc(o.patient_name)}</div>
        ${o.phone ? `<div class="ph">${esc(o.phone)}</div>` : ''}
        <div class="sm">${esc((o.notify_methods || []).join('・'))}</div>
        <div class="sm b">${esc(shortHosp(o.hospital_code, o.hospital_name))}</div>
        ${o.dept_name ? `<div class="sm b">${esc(o.dept_name)}</div>` : ''}
      </div>
      <div class="qrw"><div class="qr">${qrSvg(o.order_no)}</div><div class="no">${esc(fmtNo(o.order_no))}</div></div>
    </div>
    <div class="fl" style="font-size:${size}pt">${fl}</div>
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
    html,body{margin:0;padding:0;font-family:${FONT};color:#000}
    .lb{width:40mm;height:30mm;padding:1.3mm 1.5mm 1mm;box-sizing:border-box;display:flex;flex-direction:column;page-break-after:always;overflow:hidden}
    .top{display:flex;gap:1.2mm;align-items:flex-start}
    .info{min-width:0;flex:1;line-height:1.18}
    .nm{font-size:10.5pt;font-weight:900;white-space:nowrap;overflow:hidden}
    .ph{font-size:7.5pt;font-weight:700;font-family:Arial,sans-serif;letter-spacing:.1px}
    .sm{font-size:6.3pt;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sm.b{font-weight:700}
    .qrw{flex:none;width:13mm;text-align:center}
    .qr{width:13mm;height:13mm}.qr svg{width:100%;height:100%;display:block}
    .no{font-size:4.6pt;font-family:Arial,sans-serif;margin-top:.3mm;white-space:nowrap}
    .fl{margin-top:auto;border-top:.25mm solid #000;padding-top:.5mm;font-weight:900;font-family:"Arial Narrow",Arial,${FONT};
      display:flex;justify-content:space-between;white-space:nowrap;line-height:1.1;letter-spacing:-.2px}
    .fl span{display:flex;align-items:center}
    .fl i{font-style:normal;background:#000;color:#fff;border-radius:50%;width:1.15em;height:1.15em;font-size:.5em;
      display:inline-grid;place-items:center;margin-right:.12em;font-family:Arial,sans-serif}`,
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
