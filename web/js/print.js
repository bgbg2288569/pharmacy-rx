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
function labelHtml(o, fills) {
  const fs = fillsActive(fills);
  const W = 37;                                         // 可用寬度（40mm − 左右邊界）
  const RW = 20.2;                                      // 右側文字欄寬度（姓名與醫院等同寬）
  const lines = [
    ['h', shortHosp(o.hospital_code, o.hospital_name)],
    ['d', o.dept_name],
    ['p', o.phone],
    ['n', notifyText(o.notify_methods)],
  ].filter(x => x[1]);
  const lineMax = lines.length <= 3 ? 3.4 : 3;
  const info = lines.map(([k, t]) => `<div class="${k}" style="font-size:${fit(t, RW, lineMax)}mm">${esc(t)}</div>`).join('');
  // 領藥日：序號用 ➊➋➌（實心黑圓白字的文字符號，不靠底色，熱感印表機也印得出來）
  const each = fs.length ? W / fs.length : W;
  const dsz = Math.min(5.2, (each - 1.2) / 3.8).toFixed(2);
  const fl = fs.map(f => `<span><b>${SEQ_MARK[f.seq] || f.seq}</b>${mdOf(f.due_date)}</span>`).join('');
  return `<div class="lb">
    <div class="mid">
      <div class="qrw"><div class="qr">${qrSvg(o.order_no)}</div><div class="no">${esc(fmtNo(o.order_no))}</div></div>
      <div class="info">
        <div class="nm" style="font-size:${fit(o.patient_name, RW, 5.6)}mm">${esc(o.patient_name)}</div>
        ${info}
      </div>
    </div>
    <div class="fl${fs.length === 1 ? ' one' : ''}" style="font-size:${dsz}mm">${fl}</div>
  </div>`;
}

// 57mm 熱感發票紙：上半「藥局聯」（留店內，含完整電話、通知方式、備註），撕線下「客戶聯」（給客人，含醫院科別與領藥日）
// 熱感機 203dpi、只能印純黑：Logo 用單色兩個圓（實心＋圓環），不用漸層、灰階與細線
const LOGO_MONO = `<svg viewBox="0 0 40 40" class="lg" aria-hidden="true"><circle cx="14.5" cy="24" r="10" fill="#000"/><circle cx="25.5" cy="15.5" r="8.6" fill="none" stroke="#fff" stroke-width="8"/><circle cx="25.5" cy="15.5" r="8.6" fill="none" stroke="#000" stroke-width="4.2"/></svg>`;
function receiptHtml(o, fills) {
  const fs = fillsActive(fills);
  const store = esc(curStore()?.name || '');
  const no = esc(fmtNo(o.order_no));
  const hosp = esc(shortHosp(o.hospital_code, o.hospital_name) || o.hospital_name || '');
  const dates = fs.map(f => `<div class="d"><b>${SEQ_MARK[f.seq] || f.seq}</b><span class="md">${rocOf(f.due_date, true)}</span></div>`).join('')
    || '<div class="d none">（未排定）</div>';
  const notify = (o.notify_methods || []);
  const footer = esc(storeSetting('receipt_footer', ''));
  const head = (copy) => `<div class="top">${LOGO_MONO}<div class="sn"><div class="s1">${store}</div><div class="s2">慢性處方箋寄單</div></div><div class="cp">${copy}</div></div>`;
  return `<div class="rc">
    ${head('藥局聯')}
    <div class="idrow"><div class="qr">${qrSvg(o.order_no)}</div>
      <div class="idt"><div class="lbl">寄單編號</div><div class="no">${no}</div></div></div>
    <div class="nm">${esc(o.patient_name)}</div>
    ${o.phone ? `<div class="ph">${esc(o.phone)}</div>` : ''}
    <div class="sec">通知方式</div>
    <div class="nt">${notify.length ? notify.map(m => `<span>${esc(m)}</span>`).join('') : '<em>未指定</em>'}</div>
    <div class="sec">領藥日</div>
    <div class="ds">${dates}</div>
    ${hosp || o.dept_name ? `<div class="hp">${hosp}${o.dept_name ? '｜' + esc(o.dept_name) : ''}</div>` : ''}
    ${o.note ? `<div class="sec">備註</div><div class="memo">${esc(o.note)}</div>` : ''}
    <div class="meta">${dtOf(o.created_at || new Date())}${o.created_staff_name ? '　' + esc(o.created_staff_name) : ''}</div>
    <div class="cut">✂ ─ ─ ─ 請沿此線撕開 ─ ─ ─</div>
    ${head('客戶聯')}
    <div class="nm">${esc(o.patient_name)}<small>${o.birth_date ? fullOf(o.birth_date) : ''}</small></div>
    <table class="kv">
      ${hosp ? `<tr><th>醫院</th><td>${hosp}</td></tr>` : ''}
      ${o.dept_name ? `<tr><th>科別</th><td>${esc(o.dept_name)}</td></tr>` : ''}
      ${o.phone ? `<tr><th>電話</th><td class="num">${esc(maskPhone(o.phone))}</td></tr>` : ''}
      <tr><th>編號</th><td class="num">${no}</td></tr>
    </table>
    <div class="sec">領藥日</div>
    <div class="ds">${dates}</div>
    <div class="tip">藥品預作完成後依您選擇的方式通知，領藥請攜帶健保卡與本單。</div>
    ${footer ? `<div class="ft">${footer}</div>` : ''}
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
    .mid{display:flex;gap:1.3mm;align-items:center;flex:1;min-height:0}
    .qrw{flex:none;width:15.5mm;text-align:center;background:#fff}
    .qr{width:15mm;height:15mm;margin:0 auto}.qr svg{width:100%;height:100%;display:block}
    .no{font-size:2.25mm;font-weight:700;font-family:Arial,sans-serif;margin-top:.4mm;white-space:nowrap;letter-spacing:-.03mm}
    .info{min-width:0;flex:1;line-height:1.13;font-weight:700}
    .info>div{white-space:nowrap;overflow:hidden}
    .info .nm{font-weight:900;line-height:1.1;margin-bottom:.3mm}
    .info .p{font-family:Arial,sans-serif;font-weight:900;letter-spacing:-.04mm}
    .fl{border-top:.55mm solid #000;padding-top:.5mm;font-weight:700;font-family:Arial,${FONT};
      display:flex;justify-content:space-around;white-space:nowrap;line-height:1.1;letter-spacing:.02em}
    .fl span{display:flex;align-items:center}
    .fl b{font-family:"Segoe UI Symbol","Microsoft JhengHei","Noto Sans Symbols 2","DejaVu Sans",sans-serif;font-weight:400;
      font-size:1.08em;line-height:1;position:relative;top:.07em;margin-right:.18em;letter-spacing:0}`,
  // 57mm 紙、可列印寬度約 48mm；字以粗黑為主，不用灰色（熱感機灰色會變淡或消失）
  receipt: `@page{size:57mm auto;margin:0}
    *{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}
    html,body{margin:0;padding:0;font-family:${FONT};color:#000;background:#fff}
    .rc{width:48mm;margin:0 auto;padding:2mm 0 8mm;font-size:10.5pt;line-height:1.3;page-break-after:always}
    .num,.no,.ph,.md{font-family:Arial,"Helvetica Neue",sans-serif}
    .top{display:flex;align-items:center;gap:1.6mm;padding-bottom:1.4mm;border-bottom:.6mm solid #000}
    .lg{width:8mm;height:8mm;flex:none}
    .sn{flex:1;min-width:0;line-height:1.15}.s1{font-size:12pt;font-weight:900;white-space:nowrap;overflow:hidden}.s2{font-size:8pt;font-weight:700;white-space:nowrap}
    .cp{flex:none;background:#000;color:#fff;font-weight:900;font-size:10pt;padding:.8mm 1.6mm;border-radius:1mm}
    .idrow{display:flex;align-items:center;gap:2mm;margin-top:2mm}
    .qr{width:16mm;height:16mm;flex:none}.qr svg{width:100%;height:100%;display:block}
    .idt{min-width:0}.lbl{font-size:8.5pt;font-weight:700}.no{font-size:12pt;font-weight:900;white-space:nowrap}
    .nm{font-size:20pt;font-weight:900;line-height:1.15;margin-top:2mm;word-break:break-all}
    .nm small{display:block;font-size:10pt;font-weight:700;font-family:Arial,sans-serif;margin-top:.3mm}
    .ph{font-size:15pt;font-weight:900;letter-spacing:.3mm}
    .sec{margin-top:2.2mm;font-size:8.5pt;font-weight:900;letter-spacing:.6mm;display:flex;align-items:center;gap:1.2mm}
    .sec::after{content:"";flex:1;border-top:.35mm solid #000}
    .nt{display:flex;flex-wrap:wrap;gap:1.2mm;margin-top:.8mm}
    .nt span{border:.5mm solid #000;border-radius:1mm;padding:.2mm 1.6mm;font-size:13pt;font-weight:900}
    .nt em{font-style:normal;font-weight:700}
    .ds{margin-top:.6mm}
    .d{display:flex;align-items:center;gap:1.6mm;font-size:15pt;font-weight:900;line-height:1.35}
    .d b{font-family:"Segoe UI Symbol","Microsoft JhengHei","Noto Sans Symbols 2","DejaVu Sans",sans-serif;font-weight:400;font-size:16pt;line-height:1}
    .d.none{font-size:11pt}
    .hp{margin-top:1.4mm;font-size:10.5pt;font-weight:700}
    .memo{margin-top:.6mm;font-size:11pt;font-weight:700;word-break:break-all}
    .meta{margin-top:2mm;font-size:8.5pt;font-weight:700}
    .cut{margin:4mm 0 3mm;text-align:center;font-size:8.5pt;font-weight:700;white-space:nowrap;overflow:hidden}
    .kv{width:100%;border-collapse:collapse;margin-top:1.4mm}
    .kv th{width:9mm;text-align:left;font-size:9pt;font-weight:900;vertical-align:top;padding:.5mm 0;white-space:nowrap}
    .kv td{font-size:11.5pt;font-weight:700;padding:.5mm 0;word-break:break-all}
    .tip{margin-top:2.4mm;font-size:9pt;font-weight:700;border:.4mm solid #000;border-radius:1mm;padding:1mm 1.4mm;line-height:1.35}
    .ft{margin-top:2mm;text-align:center;font-size:9pt;font-weight:700}`,
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
/** 貼紙要印的內容（與調劑系統 rx_intake 回傳的 label 格式相同），交給 RxBridge 直接列印 */
export function labelData(o, fills) {
  return {
    order_no: o.order_no, order_no_fmt: fmtNo(o.order_no), patient_name: o.patient_name || '',
    hospital: shortHosp(o.hospital_code, o.hospital_name) || '', dept: o.dept_name || '', phone: o.phone || '',
    notify: notifyText(o.notify_methods),
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
