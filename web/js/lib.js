// 共用：Supabase、全域狀態、日期（民國年）、寄單編號檢核、提示音、人員代碼、藥局系統橋接
import { reactive, watch, onUnmounted } from 'vue';
import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';

export const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

export const NOTIFY = ['LINE', '簡訊', '電話', '自取'];
/** 藥局系統客戶備註（sa110.allergy）判斷通知方式：含 LINE → LINE、含「簡訊」→ 簡訊、含「電話」→ 電話 */
export function notifyFromMemo(memo) {
  const t = String(memo || '');
  return NOTIFY.filter(m => (m === 'LINE' ? /line/i.test(t) : m !== '自取' && t.includes(m)));
}
export const NOTIFY_CLS = { LINE: 'line', 簡訊: 'sms', 電話: 'tel', 自取: 'self' };
// 寄單流程到「已通知」結束（自取＝預作完成即結束），領藥回歸藥局系統
export const FILL_STATUS = { pending: '寄放中', prepared: '已預作', notified: '已通知', picked: '已領取', cancelled: '已取消' };
export const ORDER_STATUS = { active: '進行中', closed: '已完成', cancelled: '已取消' };
export const ACTION_LABEL = {
  create: '寄單建檔', intake: '調劑輸出系統匯入', edit: '修改資料', print: '列印單據', prepare: '預作確認', unprepare: '取消預作',
  family: '連結同行家人', unfamily: '解除同行家人',
  notify: '已通知', unnotify: '撤銷通知', pickup: '已領取', unpickup: '撤銷領取', cancel: '取消', restore: '復原',
};
export const CIRCLED = ['', '①', '②', '③'];

export const state = reactive({
  ready: false, user: null, profile: null, authMsg: '',
  stores: [], storeId: null, depts: [], settings: {},
  staff: [], quick: [], phrases: [],
  route: 'entry', detailId: null, ask: null, toasts: [], tick: 0, counts: {}, busy: [],
  operator: null, bridge: 'off', confirm: null,
  draft: null, lastSaved: null,          // 寄單輸入暫存：切換頁面保留，登出／重新整理／切換門市才清空
  searchSaved: null,                     // 寄單查詢條件：切換頁面保留，登出／重新整理才清空
  dirty: {},                             // 各設定區塊是否有未儲存變更 { key: true }
});

// ---------------- 未儲存變更 ----------------
export const hasUnsaved = () => Object.values(state.dirty).some(Boolean);
/** 有未儲存變更時詢問是否放棄；回傳 true 表示可以繼續（離開／切換） */
export function confirmLeave(what = '離開這個頁面') {
  if (!hasUnsaved()) return true;
  if (!window.confirm(`還有未儲存的變更，確定要${what}？\n（按「取消」留在本頁，可先按「儲存全部」）`)) return false;
  state.dirty = {};
  return true;
}
/** 在元件中登記「是否有未儲存變更」，元件卸載時自動清除 */
export function useDirty(key, dirtyRef) {
  watch(dirtyRef, v => { state.dirty = { ...state.dirty, [key]: !!v }; }, { immediate: true });
  onUnmounted(() => { const d = { ...state.dirty }; delete d[key]; state.dirty = d; });
}

export const isAdmin = () => state.profile?.role === 'admin';
export const curStore = () => state.stores.find(s => s.id === state.storeId) || null;
export function storeSetting(key, def) {
  const v = curStore()?.settings?.[key];
  if (v !== undefined && v !== null && v !== '') return v;
  const g = state.settings[key];
  return g !== undefined && g !== null && g !== '' ? g : def;
}
export const bump = () => { state.tick++; };

// ---------------- RPC / 錯誤 ----------------
export async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw new Error(cleanErr(error.message));
  return data;
}
export function cleanErr(m) {
  if (!m) return '發生錯誤';
  if (/JWT|jwt/.test(m)) return '登入已逾時，請重新登入';
  if (/Failed to fetch|NetworkError/.test(m)) return '網路連線失敗，請稍後再試';
  return m;
}
export async function q(builder) {
  const { data, error } = await builder;
  if (error) throw new Error(cleanErr(error.message));
  return data;
}

// ---------------- toast / 聲音 ----------------
let toastId = 0;
export function toast(msg, type = 'info', ms = 2600) {
  const id = ++toastId;
  state.toasts.push({ id, msg, type });
  setTimeout(() => { const i = state.toasts.findIndex(t => t.id === id); if (i >= 0) state.toasts.splice(i, 1); }, ms);
}
export const toastErr = e => toast(e?.message || String(e), 'err', 4200);

let actx;
export function beep(kind = 'ok') {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const seq = kind === 'ok' ? [[1046, .09]] : kind === 'warn' ? [[660, .12], [660, .12]] : [[220, .28]];
    let t = actx.currentTime;
    for (const [f, d] of seq) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = kind === 'err' ? 'square' : 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(.18, t); g.gain.exponentialRampToValueAtTime(.001, t + d);
      o.connect(g).connect(actx.destination); o.start(t); o.stop(t + d);
      t += d + .05;
    }
  } catch { /* 無音效裝置時略過 */ }
}

// ---------------- 日期（民國年） ----------------
const pad = n => String(n).padStart(2, '0');
const WK = '日一二三四五六';
export const isoOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = () => isoOf(new Date());
export function parseISO(s) { const [y, m, d] = s.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); }
export function addDays(iso, n) { const d = parseISO(iso); d.setDate(d.getDate() + n); return isoOf(d); }
export const diffDays = (a, b) => Math.round((parseISO(a) - parseISO(b)) / 864e5);
export const weekOf = iso => (iso ? WK[parseISO(iso).getDay()] : '');
// 畫面日期統一 MM/DD（完整民國日期放在 title 提示）
export function rocOf(iso, week = false) {
  if (!iso) return '';
  const d = parseISO(iso);
  const s = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  return week ? `${s}(${WK[d.getDay()]})` : s;
}
export const mdOf = iso => rocOf(iso);
// 完整民國日期 075/03/12；生日可含隱碼 075/＊＊/12
export function fullOf(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${String(Number(y) - 1911).padStart(3, '0')}/${m}/${d}`;
}
export function dtOf(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export const dayOf = ts => dtOf(ts).slice(0, 5);
export const timeOf = ts => dtOf(ts).slice(6);
/** 年齡；生日有隱碼時回傳「約N」 */
export function ageOf(birth) {
  if (!birth) return '';
  const [y, m, d] = String(birth).split('-');
  const t = new Date();
  let a = t.getFullYear() - Number(y);
  if (m === '**') return '約' + (a - (t.getMonth() < 6 ? 1 : 0));
  const tm = t.getMonth() + 1, bm = Number(m);
  if (d === '**') return tm < bm ? a - 1 : tm > bm ? a : '約' + a;
  if (tm < bm || (tm === bm && t.getDate() < Number(d))) a--;
  return a;
}
// 生日比對：隱碼（＊＊）視為相符
export function birthMatch(a, b) {
  if (!a || !b) return true;
  const x = String(a).split('-'), y = String(b).split('-');
  return x.every((v, i) => v === '**' || y[i] === '**' || v === y[i]);
}
// 生日輸入（支援醫院隱碼）：0750312、750312、75/03/12、75/＊＊/12、65/02/＊＊、075＊＊12
// 回傳 1986-03-12 或 1986-＊＊-12（存兩個半形星號）；'' 空白；null 格式錯誤（年份不可隱碼）
export function parseBirthInput(raw) {
  const s = String(raw ?? '').trim().replace(/[＊xX]/g, '*').replace(/[年月]/g, '/').replace(/日/g, '');
  if (!s) return '';
  let y, m, d;
  if (/^[\d*]+$/.test(s)) {
    if (s.length === 7) [y, m, d] = [s.slice(0, 3), s.slice(3, 5), s.slice(5, 7)];
    else if (s.length === 6) [y, m, d] = [s.slice(0, 2), s.slice(2, 4), s.slice(4, 6)];
    else if (s.length === 8) [y, m, d] = [s.slice(0, 4), s.slice(4, 6), s.slice(6, 8)];
    else return null;
  } else {
    const p = s.split(/[\/\-. ]+/).filter(Boolean);
    if (p.length !== 3) return null;
    [y, m, d] = p;
  }
  if (!/^\d{1,4}$/.test(y)) return null;
  let yy = Number(y); if (yy < 1000) yy += 1911;
  const part = (v, max) => (/^\*+$/.test(v) ? '**' : /^\d{1,2}$/.test(v) && Number(v) >= 1 && Number(v) <= max ? pad(Number(v)) : null);
  const mm = part(m, 12), dd = part(d, 31);
  if (!mm || !dd) return null;
  if (mm !== '**' && dd !== '**') return mk(yy, Number(mm), Number(dd));
  return `${yy}-${mm}-${dd}`;
}
export const isMasked = b => String(b || '').includes('*');
/** Enter 跳到下一個 data-nav 欄位（給非同步帶入後使用） */
export function focusNext(el) {
  const items = [...document.querySelectorAll('[data-nav]')].filter(x => !x.disabled && x.offsetParent !== null);
  const i = items.indexOf(el);
  if (i >= 0) items[i + 1]?.focus();
}
/** 生日顯示：民國 075/03/12（40歲） */
export const birthOf = (birth, withAge = false) => (birth ? `${fullOf(birth)}${withAge ? `（${ageOf(birth)}歲）` : ''}` : '');
/** 醫院簡稱：門市常用清單的簡稱優先，否則去掉法人／機關前綴 */
export function shortHosp(code, name) {
  const q = code && state.quick.find(x => x.hospital_code === code);
  if (q?.label) return q.label;
  return String(name || '')
    .replace(/[（(〈【<].*?[）)〉】>]/g, '')
    .replace(/^.*?(醫療財團法人|財團法人|社團法人)/, '')
    .replace(/^.{2,20}?基金會(?=.)/, '')
    .replace(/^(行政院國軍退除役官兵輔導委員會|行政院衛生署|衛生福利部|國防部|國立|私立|台灣基督長老教會|基督長老教會|天主教)+/, '')
    .trim();
}
export const selfOnly = m => (m || []).length > 0 && m.every(x => x === '自取');
function mk(y, m, d) {
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? isoOf(dt) : null;
}
/**
 * 民國日期快速輸入：
 *  1151113 / 115/11/13 / 115-11-13 / 115.11.13 → 2026-11-13
 *  20261113 / 2026/11/13 → 西元
 *  1113 / 11/13 → 今年（若早於今天 60 天以上則視為明年）
 *  +7 / -3 → 今天加減天數
 * 回傳：'' 空白、ISO 字串、null 無法解析
 */
export function parseRocInput(raw, today = todayISO()) {
  const s = String(raw ?? '').trim().replace(/[年月]/g, '/').replace(/日/g, '');
  if (!s) return '';
  let m;
  if ((m = s.match(/^([+-])\s*(\d{1,3})$/))) return addDays(today, (m[1] === '-' ? -1 : 1) * Number(m[2]));
  const ty = parseISO(today).getFullYear();
  const yearOf = y => (y < 1000 ? y + 1911 : y);
  const md = (mo, d) => {
    let v = mk(ty, mo, d);
    if (v && diffDays(v, today) < -60) v = mk(ty + 1, mo, d);
    return v;
  };
  if (/^\d+$/.test(s)) {
    if (s.length === 7) return mk(Number(s.slice(0, 3)) + 1911, Number(s.slice(3, 5)), Number(s.slice(5, 7)));
    if (s.length === 8) return mk(Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6, 8)));
    if (s.length === 6) return mk(Number(s.slice(0, 2)) + 1911, Number(s.slice(2, 4)), Number(s.slice(4, 6)));
    if (s.length === 4) return md(Number(s.slice(0, 2)), Number(s.slice(2, 4)));
    if (s.length === 3) return md(Number(s.slice(0, 1)), Number(s.slice(1, 3)));
    return null;
  }
  const p = s.split(/[\/\-. ]+/).filter(Boolean).map(Number);
  if (p.some(isNaN)) return null;
  if (p.length === 3) return mk(yearOf(p[0]), p[1], p[2]);
  if (p.length === 2) return md(p[0], p[1]);
  return null;
}

// ---------------- 寄單編號：YYMMDD + 4碼流水 + Luhn 檢核碼 ----------------
export function luhn(base) {
  let s = 0, dbl = true;
  for (let i = base.length - 1; i >= 0; i--) {
    let d = Number(base[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    s += d; dbl = !dbl;
  }
  return (10 - (s % 10)) % 10;
}
export function validOrderNo(code) {
  const c = String(code || '').replace(/\D/g, '');
  return /^\d{11}$/.test(c) && luhn(c.slice(0, 10)) === Number(c[10]);
}
export const fmtNo = no => (no && no.length === 11 ? `${no.slice(0, 6)}-${no.slice(6, 10)}-${no[10]}` : no || '');

// ---------------- 其他 ----------------
export const maskPhone = p => (!p ? '' : p.length >= 8 ? p.slice(0, 4) + '***' + p.slice(-3) : p);
export const onlyDigits = (v, max = 10) => String(v || '').replace(/\D/g, '').slice(0, max);
export function fillTpl(tpl, o, f) {
  return String(tpl || '')
    .replaceAll('{name}', o.patient_name || '')
    .replaceAll('{store}', curStore()?.name || '')
    .replaceAll('{seq}', f?.seq ?? '')
    .replaceAll('{date}', f?.due_date ? rocOf(f.due_date, true) : '')
    .replaceAll('{order_no}', o.order_no || '');
}
export async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('已複製', 'ok', 1400); }
  catch {
    const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove(); toast('已複製', 'ok', 1400);
  }
}
export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export const ls = {
  get(k, d) { try { const v = localStorage.getItem('rx_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rx_' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ---------------- 人員代碼 ----------------
export function findStaff(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  return state.staff.find(s => s.code === c && s.store_id === state.storeId)
      || state.staff.find(s => s.code === c && !s.store_id) || null;
}
/** 跳出人員代碼視窗，回傳 {code,name} 或 null（取消） */
export const DEFAULT_CANCEL_REASONS = ['病人取消', '改至他處領藥', '處方有誤', '重複寄單', '醫師改藥'];
// 確認視窗（取代瀏覽器 confirm）：回傳 true / false
export function askConfirm(opts) {
  return new Promise(resolve => { state.confirm = { okText: '確定', cancelText: '取消', ...opts, resolve }; });
}
// opts.reason：同時填寫原因（取消時使用）
export function askStaff(title = '請輸入人員代碼', desc = '', opts = {}) {
  return new Promise(resolve => { state.ask = { title, desc, ...opts, resolve }; });
}
/** 批次作業（預作、通知）用：同一操作人員沿用，直到切換 */
export async function ensureOperator() {
  if (state.operator) return state.operator;
  const s = await askStaff('設定操作人員', '預作與通知作業會以此人員記錄，可隨時在頁面上切換。');
  if (s) setOperator(s);
  return s;
}
export function setOperator(s) {
  state.operator = s;
  try { sessionStorage.setItem('rx_operator_' + state.storeId, JSON.stringify(s)); } catch { /* ignore */ }
}
export function restoreOperator() {
  try { state.operator = JSON.parse(sessionStorage.getItem('rx_operator_' + state.storeId) || 'null'); }
  catch { state.operator = null; }
}

// ---------------- 載入基本資料 ----------------
export async function loadStoreData() {
  if (!state.storeId) return;
  const sid = state.storeId;
  const [staff, quick, phrases] = await Promise.all([
    q(sb.from('rx_staff').select('*').eq('active', true).or(`store_id.eq.${sid},store_id.is.null`).order('code')),
    q(sb.from('rx_hospital_quick').select('*, rx_hospitals(name)').eq('store_id', sid).order('sort').order('quick_code')),
    q(sb.from('rx_phrases').select('*').or(`store_id.eq.${sid},store_id.is.null`).order('store_id', { nullsFirst: false }).order('sort')),
  ]);
  if (sid !== state.storeId) return;
  state.staff = staff;
  state.quick = quick.map(x => ({ ...x, name: x.rx_hospitals?.name || x.hospital_code }));
  state.phrases = phrases;
  restoreOperator();
  pingBridge();
}
export async function loadCommon() {
  const [stores, depts, settings] = await Promise.all([
    q(sb.from('rx_stores').select('*').order('sort')),
    q(sb.from('rx_departments').select('*').eq('active', true).order('sort')),
    q(sb.from('rx_settings').select('*')),
  ]);
  state.stores = stores;
  state.depts = depts;
  state.settings = Object.fromEntries(settings.map(s => [s.key, s.value]));
}
export async function refreshCounts() {
  if (!state.storeId) return;
  const t = todayISO(), ahead = Number(storeSetting('prep_days_ahead', 7));
  try {
    state.counts = await rpc('rx_dashboard', {
      p_store: state.storeId, p_prep_from: addDays(t, ahead), p_prep_to: addDays(t, ahead),
      p_overdue_days: Number(storeSetting('overdue_days', 7)),
    });
  } catch { /* 統計失敗不影響作業 */ }
}

// ---------------- 本地藥局系統橋接（福原等，透過 RxBridge 讀 ODBC） ----------------
export const bridgeUrl = () => String(storeSetting('bridge_url', '') || '').replace(/\/+$/, '');
export async function pingBridge() {
  const u = bridgeUrl();
  if (!u) { state.bridge = 'off'; return; }
  try {
    const r = await fetch(u + '/health', { signal: AbortSignal.timeout(2000) });
    state.bridge = r.ok ? 'ok' : 'err';
  } catch { state.bridge = 'err'; }
}
export async function bridgeSearch(text) {
  const u = bridgeUrl();
  if (!u || state.bridge === 'off') return [];
  try {
    // 模糊比對（%姓名%）在藥局系統較慢，等久一點；結果晚到也會補進建議清單
    const r = await fetch(`${u}/patients?q=${encodeURIComponent(text)}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(r.status);
    state.bridge = 'ok';
    const rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch { state.bridge = 'err'; return []; }
}
/** 處方箋 QR 比對：身分證可含 *（隱碼），生日為 yyyy-MM-dd（月／日可為 **） */
export async function bridgeMatch(idno, birth) {
  const u = bridgeUrl();
  if (!u || state.bridge === 'off' || (!idno && !birth)) return [];
  try {
    const r = await fetch(`${u}/match?idno=${encodeURIComponent(idno || '')}&birth=${encodeURIComponent(birth || '')}`, { signal: AbortSignal.timeout(8000) });
    if (r.status === 404) return [];       // 舊版 RxBridge（v1.5 以前）沒有 /match：不算斷線，只是查不到藥局系統資料
    if (!r.ok) throw new Error(r.status);
    state.bridge = 'ok';
    const rows = await r.json();
    return Array.isArray(rows) ? rows : [];
  } catch { state.bridge = 'err'; return []; }
}

// ---------------- 紙本處方箋 QR（健保處方 QR，欄位以 ; 分隔）----------------
// 1 醫事機構代碼、4 姓名（掃描槍常變亂碼）、5 身分證（可能 * 隱碼）、6 民國生日（可能 * 隱碼）、7 科別
/** 判斷輸入是否像處方箋 QR（給姓名欄等地方自動辨識用） */
export const looksLikeRxQr = t => /^\s*[0-9A-Z]{10}\s*;/.test(String(t || '')) && String(t).split(';').length >= 8;
/** 解析處方箋 QR，失敗回傳 null */
export function parseRxQr(raw) {
  const t = String(raw || '').replace(/\r?\n/g, '').trim();
  const c = t.split(';').map(x => x.trim());
  if (c.length < 8 || !/^[0-9A-Z]{10}$/i.test(c[0])) return null;
  const idno0 = c[4].toUpperCase().replace(/＊/g, '*');
  const idno = /^[A-Z*][A-D0-9*][0-9*]{8}$/.test(idno0) && (idno0.match(/\*/g) || []).length <= 6 ? idno0 : '';
  const b = parseBirthInput(c[5]);
  let dept = c[6].toUpperCase();
  if (/^\d$/.test(dept)) dept = '0' + dept;
  // 姓名：含 ? 或非中英文字元多半是掃描槍編碼錯誤，只拿來參考比對
  const name = c[3];
  const nameOk = !!name && !/[?？�]/.test(name);
  return {
    hospital_code: c[0].toUpperCase(), name, nameOk, idno, idno_raw: c[4],
    birth_date: b || '', birth_raw: c[5], dept_code: dept,
    rx_date: c[7] || '', days: c[9] || '',
  };
}

// ---------------- 掃描槍防呆（全站）----------------
// 掃描槍是「很快的鍵盤」：連續 9 個以上按鍵、間隔都 < 35ms 才視為掃描中（寄單編號 11 碼、處方 QR 更長）。
// 打字（含中文輸入法選字時一次送出好幾個按鍵）不會連續這麼多下，避免手打關鍵字被誤判。掃描中：
//   * 游標不在文字輸入框（例如停在按鈕上）→ 擋下所有按鍵，避免 Enter／空白鍵按到「列印」等按鈕
//   * 開著中文輸入法（按鍵送進輸入法）→ 擋下 Enter、空白、F1～F12，掃描結束後清空該欄位並提示切換英數
//   * F1～F12 一律擋下（避免觸發儲存／列印快捷鍵）
export const scanGuard = { active: false, ime: 0, lastEnd: 0, el: null };
export const recentlyScanned = (ms = 800) => scanGuard.active || performance.now() - scanGuard.lastEnd < ms;
let sgLast = 0, sgRun = 0, sgImeRun = 0, sgTimer = null;
const isTextInput = el => !!el && ((el.tagName === 'INPUT' && !/^(button|submit|checkbox|radio|file|reset|image)$/i.test(el.type)) || el.tagName === 'TEXTAREA');
function sgEnd() {
  if (scanGuard.active && scanGuard.ime >= 8) {
    const el = scanGuard.el;
    if (isTextInput(el)) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    toast('掃描時開著中文輸入法，內容變成亂碼已清除。請按 Shift 切換成英數後重新掃描', 'err', 6000);
    beep('err');
  }
  if (scanGuard.active) scanGuard.lastEnd = performance.now();
  scanGuard.active = false; scanGuard.ime = 0; scanGuard.el = null; sgRun = 0; sgImeRun = 0;
}
function sgKey(e) {
  const now = performance.now(), dt = now - sgLast;
  sgLast = now;
  const ime = e.isComposing || e.keyCode === 229 || e.key === 'Process';
  sgRun = dt < 35 ? sgRun + 1 : 0;
  if (sgRun >= 8 && !scanGuard.active) { scanGuard.active = true; scanGuard.el = e.target; scanGuard.ime = sgImeRun; }
  sgImeRun = dt < 35 ? sgImeRun + (ime ? 1 : 0) : (ime ? 1 : 0);
  if (scanGuard.active) {
    if (ime) scanGuard.ime++;
    clearTimeout(sgTimer); sgTimer = setTimeout(sgEnd, 300);
    const fkey = /^F\d{1,2}$/.test(e.key);
    const block = fkey || !isTextInput(e.target) || (scanGuard.ime > 0 && (e.key === 'Enter' || e.key === ' ' || ime));
    if (block) { e.preventDefault(); e.stopPropagation(); }
  }
}
let sgInstalled = false;
export function installScanGuard() {
  if (sgInstalled) return;
  sgInstalled = true;
  window.addEventListener('keydown', sgKey, true);
}

// ---------------- 進行中提示（切換門市、查詢等）----------------
// 包住較慢的查詢：超過 0.25 秒畫面上方中央會出現「搜尋中…」小提示，完成後自動消失
let busySeq = 0;
export async function withBusy(p, text = '搜尋中…') {
  const id = ++busySeq;
  state.busy.push({ id, text });
  try { return await p; } finally { const i = state.busy.findIndex(x => x.id === id); if (i >= 0) state.busy.splice(i, 1); }
}
