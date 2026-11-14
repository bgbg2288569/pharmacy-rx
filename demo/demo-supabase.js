// =====================================================================
// 試用版假 Supabase：資料存在瀏覽器 localStorage，規則與 01_schema.sql 的 RPC 一致
// 只在試用版使用，正式版改回 @supabase/supabase-js
// =====================================================================
import { HOSPITALS, DEPARTMENTS } from './demo-data.js';

const KEY = 'rx_demo_db_v4';
const SKEY = 'rx_demo_session';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 無法儲存時僅保留在記憶體 */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---------------------------------------------------------------- 日期工具
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const addDays = (s, n) => { const [y, m, d] = s.split('-').map(Number); const x = new Date(y, m - 1, d + n); return iso(x); };
const dayDiff = (a, b) => Math.round((new Date(a) - new Date(b)) / 864e5);
const nowTs = () => new Date().toISOString();
const tsAt = (dateIso, h = 10, mi = 0) => { const [y, m, d] = dateIso.split('-').map(Number); return new Date(y, m - 1, d, h, mi).toISOString(); };
const luhn = base => { let s = 0, dbl = true; for (let i = base.length - 1; i >= 0; i--) { let d = +base[i]; if (dbl) { d *= 2; if (d > 9) d -= 9; } s += d; dbl = !dbl; } return (10 - s % 10) % 10; };
const validNo = c => /^\d{11}$/.test(c) && luhn(c.slice(0, 10)) === +c[10];

// ---------------------------------------------------------------- 示範資料
function seed() {
  const db = {
    seq: { rx_orders: 0, rx_fills: 0, rx_logs: 0, rx_staff: 0, rx_phrases: 0 },
    counters: {},
    rx_stores: [
      { id: '03', name: '福原藥局', short_name: '福原', sort: 1, active: true, settings: { prep_days_ahead: 7, default_notify: ['LINE'], quick_depts: ['02', 'AB', 'AG', 'AD', '12', 'AA'] } },
      { id: '04', name: '日新藥局', short_name: '日新', sort: 2, active: true, settings: { prep_days_ahead: 7, overdue_days: 7 } },
      { id: '07', name: '博亞藥局', short_name: '博亞', sort: 3, active: true, settings: { prep_days_ahead: 7, overdue_days: 7 } },
    ],
    rx_users: [
      { id: 'u-admin', account: 'admin', display_name: '管理員', role: 'admin', store_id: '03', active: true },
      { id: 'u-fuyuan', account: 'fuyuan', display_name: '福原藥局', role: 'store', store_id: '03', active: true },
      { id: 'u-rixin', account: 'rixin', display_name: '日新藥局', role: 'store', store_id: '04', active: true },
      { id: 'u-boya', account: 'boya', display_name: '博亞藥局', role: 'store', store_id: '07', active: true },
    ],
    rx_staff: [], rx_phrases: [], rx_orders: [], rx_fills: [], rx_logs: [],
    rx_hospital_quick: [
      { store_id: '03', quick_code: '01', hospital_code: '0401180014', label: '台大', default_dept: null, sort: 1 },
      { store_id: '03', quick_code: '02', hospital_code: '1131010011', label: '亞東', default_dept: null, sort: 2 },
      { store_id: '03', quick_code: '03', hospital_code: '0601160016', label: '北榮', default_dept: null, sort: 3 },
      { store_id: '03', quick_code: '04', hospital_code: '1101100011', label: '馬偕', default_dept: null, sort: 4 },
      { store_id: '03', quick_code: '05', hospital_code: '1132070011', label: '林口長庚', default_dept: null, sort: 5 },
      { store_id: '03', quick_code: '06', hospital_code: '0501110514', label: '三總', default_dept: null, sort: 6 },
      { store_id: '03', quick_code: '07', hospital_code: '1231050017', label: '耕莘', default_dept: null, sort: 7 },
      { store_id: '03', quick_code: '08', hospital_code: '1131040519', label: '雙和', default_dept: null, sort: 8 },
      { store_id: '04', quick_code: '01', hospital_code: '1101020018', label: '國泰', default_dept: null, sort: 1 },
      { store_id: '04', quick_code: '02', hospital_code: '1101150011', label: '新光', default_dept: null, sort: 2 },
    ],
    rx_settings: [
      { key: 'notify_template', value: '{name} 您好，您於{store}寄放的慢性處方箋（第{seq}次）藥品已備妥，{date} 起可攜帶健保卡來領取，謝謝！' },
      { key: 'receipt_footer', value: '請保留此單據，領藥時出示可加快作業。' },
      { key: 'prep_days_ahead', value: 7 }, { key: 'overdue_days', value: 7 },
    ],
  };
  const addStaff = (store_id, code, name) => db.rx_staff.push({ id: ++db.seq.rx_staff, store_id, code, name, active: true });
  addStaff('03', '11', '王藥師'); addStaff('03', '12', '陳助理'); addStaff('03', '13', '黃藥師');
  addStaff('04', '21', '林藥師'); addStaff('07', '31', '張藥師'); addStaff(null, '99', 'Tom');
  for (const [t, s] of [['已收健保卡', 1], ['自費品項另計', 2], ['需調藥', 3], ['家屬代領', 4], ['請先電話確認', 5], ['藥品缺貨待補', 6]])
    db.rx_phrases.push({ id: ++db.seq.rx_phrases, store_id: null, text: t, sort: s });
  db.rx_phrases.push({ id: ++db.seq.rx_phrases, store_id: '03', text: '磨粉', sort: 1 });
  db.rx_phrases.push({ id: ++db.seq.rx_phrases, store_id: '03', text: '分包', sort: 2 });

  // 示範寄單：隨機但固定（seeded）
  let r = 20261113;
  const rnd = () => { r = (r + 0x6D2B79F5) | 0; let t = Math.imul(r ^ (r >>> 15), 1 | r); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const sur = '陳林黃張李王吳劉蔡楊許鄭謝郭洪曾邱廖賴周';
  const giv = ['淑芬', '志明', '美玲', '建宏', '雅婷', '俊傑', '麗華', '文雄', '秀英', '家豪', '惠君', '國華', '玉蘭', '明德', '金鳳', '正雄', '素珍', '宗翰', '月娥', '承恩'];
  const methodsPool = [['LINE'], ['LINE'], ['簡訊'], ['電話'], ['自取'], ['LINE', '簡訊'], ['電話', '簡訊']];
  const deptPool = ['02', 'AB', 'AG', 'AD', '12', '01', 'AA', '08'];
  const quick03 = db.rx_hospital_quick.filter(q => q.store_id === '03');
  const t0 = today();
  const used = new Set();
  let prev = null;
  for (let i = 0; i < 80; i++) {
    let name; do { name = pick(sur) + pick(giv); } while (used.has(name)); used.add(name);
    if (i === 5 || i === 30) name = '陳淑芬';                      // 同名同姓示範
    let birth = `${1940 + Math.floor(rnd() * 50)}-${pad(1 + Math.floor(rnd() * 12))}-${pad(1 + Math.floor(rnd() * 28))}`;
    if (i === 12) birth = birth.slice(0, 5) + '**' + birth.slice(7);   // 醫院隱碼示範
    if (i === 20) birth = birth.slice(0, 8) + '**';
    const family = prev && (i % 9 === 1) && prev.store_id === (i < 68 ? '03' : '04') ? prev : null;   // 同行家人示範
    const storeId = i < 68 ? '03' : '04';
    const created = family ? iso(new Date(family.created_at)) : addDays(t0, -Math.floor(rnd() * 50));
    const methods = family ? family.notify_methods : pick(methodsPool);
    const phone = family ? family.phone : methods.includes('自取') && rnd() < .5 ? '' : '09' + String(Math.floor(rnd() * 1e8)).padStart(8, '0');
    const q = storeId === '03' ? pick(quick03) : pick(db.rx_hospital_quick.filter(x => x.store_id === '04'));
    const hosp = HOSPITALS.find(h => h[0] === q.hospital_code);
    const dc = pick(deptPool), dept = DEPARTMENTS.find(d => d[0] === dc);
    // 第一次在醫院領，寄單的是第 2、3 次
    const d2 = family ? addDays(db.rx_fills.find(f => f.order_id === family.id && f.seq === 2).due_date, Math.floor(rnd() * 3)) : addDays(created, 20 + Math.floor(rnd() * 12));
    const fills = [{ seq: 2, due: d2 }, { seq: 3, due: addDays(d2, 28) }];
    const staff = db.rx_staff.find(s => s.store_id === storeId);
    const day = created.replace(/-/g, '').slice(2);
    db.counters[created] = (db.counters[created] || 0) + 1;
    const base = day + String(db.counters[created]).padStart(4, '0');
    const o = {
      id: ++db.seq.rx_orders, order_no: base + luhn(base), store_id: storeId, patient_name: name, phone,
      notify_methods: methods, note: rnd() < .3 ? pick(['已收健保卡', '需調藥', '家屬代領', '磨粉']) : null,
      hospital_code: q.hospital_code, hospital_name: hosp?.[1] || '', dept_code: dept[0], dept_name: dept[1],
      ext_patient_id: null, status: 'active', created_staff_code: staff.code, created_staff_name: staff.name,
      birth_date: birth, family_no: family ? family.order_no : null,
      created_at: tsAt(created, 9 + Math.floor(rnd() * 10), Math.floor(rnd() * 60)), updated_at: nowTs(),
    };
    db.rx_orders.push(o);
    if (family) family.family_no = family.order_no;
    prev = o;
    db.rx_logs.push({ id: ++db.seq.rx_logs, order_id: o.id, fill_id: null, store_id: storeId, action: 'create', detail: {}, staff_code: staff.code, staff_name: staff.name, created_at: o.created_at });
    for (const f of fills) {
      const fill = { id: ++db.seq.rx_fills, order_id: o.id, store_id: storeId, seq: f.seq, due_date: f.due, status: 'pending' };
      const lag = dayDiff(t0, f.due); // >0 已過領藥日
      const log = (action, at, extra = {}) => db.rx_logs.push({ id: ++db.seq.rx_logs, order_id: o.id, fill_id: fill.id, store_id: storeId, action, detail: { seq: f.seq, due_date: f.due, ...extra }, staff_code: staff.code, staff_name: staff.name, created_at: at });
      if (lag >= -6) { fill.status = 'prepared'; fill.prepared_at = tsAt(addDays(f.due, -7), 15); fill.prepared_by = staff.name; log('prepare', fill.prepared_at, { via_scan: true }); }
      if (lag >= -1 && !(methods.length === 1 && methods[0] === '自取') && rnd() < .85) { fill.status = 'notified'; fill.notified_at = tsAt(addDays(f.due, -1), 17); fill.notified_by = staff.name; fill.notified_via = methods.find(m => m !== '自取'); log('notify', fill.notified_at, { via: fill.notified_via }); }
      db.rx_fills.push(fill);
    }
    refresh(db, o.id);
  }
  for (const st of db.rx_stores) {
    const ds = db.rx_fills.filter(f => f.store_id === st.id && f.status !== 'pending' && f.prepared_at).map(f => f.due_date).sort();
    if (ds.length) st.settings.last_prep_date = ds[ds.length - 1];
  }
  return db;
}

let DB;
function load() {
  if (DB) return DB;
  try { DB = JSON.parse(store.get(KEY) || 'null'); } catch { DB = null; }
  if (!DB) { DB = seed(); save(); }
  return DB;
}
const save = () => store.set(KEY, JSON.stringify(DB));
export function resetDemo() { store.del(KEY); DB = null; load(); }

// 醫院 / 科別不存進 localStorage（太大），每次由內建資料建立；管理頁的修改記在 overrides
function hospitals() {
  load();
  if (!hospitals.cache) {
    const ov = DB.hospOverrides || {};
    hospitals.cache = HOSPITALS.map(([code, name]) => ({ code, name, short_name: null, active: true, updated_at: '2026-01-01', ...(ov[code] || {}) }));
    for (const code in ov) if (!HOSPITALS.some(h => h[0] === code)) hospitals.cache.push({ code, short_name: null, active: true, ...ov[code] });
  }
  return hospitals.cache;
}
function departments() {
  load();
  if (!DB.rx_departments) DB.rx_departments = DEPARTMENTS.map(([code, name, sort]) => ({ code, name, sort, active: true }));
  return DB.rx_departments;
}

// ---------------------------------------------------------------- 共用規則（與 SQL RPC 相同）
let sessionUser = null;
const me = () => DB.rx_users.find(u => u.id === sessionUser && u.active);
const isAdmin = () => me()?.role === 'admin';
const myStore = () => me()?.store_id;
const canStore = s => isAdmin() || (s && s === myStore());
class RpcError extends Error {}
const fail = m => { throw new RpcError(m); };
function staffOrFail(storeId, code) {
  const c = String(code || '').trim();
  const s = DB.rx_staff.find(x => x.active && x.code === c && x.store_id === storeId) || DB.rx_staff.find(x => x.active && x.code === c && !x.store_id);
  if (!s) fail(`人員代碼錯誤或未啟用：${c}`);
  return s;
}
function refresh(db, orderId) {
  const o = db.rx_orders.find(x => x.id === orderId);
  if (!o || o.status === 'cancelled') return;
  const self = o.notify_methods.every(m => m === '自取');
  const fs = db.rx_fills.filter(f => f.order_id === orderId);
  if (fs.length && fs.every(f => f.status === 'cancelled')) { o.status = 'cancelled'; o.updated_at = nowTs(); return; }
  o.status = db.rx_fills.some(f => f.order_id === orderId && (f.status === 'pending' || (f.status === 'prepared' && !self))) ? 'active' : 'closed';
  o.updated_at = nowTs();
}
function validate(p) {
  if (!String(p.patient_name || '').trim()) fail('請輸入姓名');
  const m = p.notify_methods || [];
  if (!m.length) fail('請選擇通知方式');
  if (p.phone && !/^\d{1,10}$/.test(p.phone)) fail('電話只能輸入數字，最多 10 碼');
  if ((m.includes('簡訊') || m.includes('電話')) && !p.phone) fail('通知方式含簡訊或電話時，電話必填');
  if (!(p.fills || []).length) fail('請至少輸入一次領藥日期');
  if (p.birth_date && !/^\d{4}-(\d{2}|\*\*)-(\d{2}|\*\*)$/.test(p.birth_date)) fail('生日格式錯誤');
}
function log(order, fill, action, detail, staff) {
  DB.rx_logs.push({ id: ++DB.seq.rx_logs, order_id: order.id, fill_id: fill?.id || null, store_id: order.store_id, action, detail, staff_code: staff?.code || null, staff_name: staff?.name || null, user_id: sessionUser, created_at: nowTs() });
}
const nameOf = (list, code) => list.find(x => x.code === code)?.name;

function fillAction(fillId, action, staffCode, extra = {}) {
  const f = DB.rx_fills.find(x => x.id === fillId) || fail('找不到領藥資料');
  const o = DB.rx_orders.find(x => x.id === f.order_id);
  if (!canStore(f.store_id)) fail('沒有此門市的權限');
  if (o.status === 'cancelled' && action !== 'restore') fail('此寄單已取消');
  const s = staffOrFail(f.store_id, staffCode);
  const t = nowTs();
  switch (action) {
    case 'prepare': if (f.status !== 'pending') fail(`第 ${f.seq} 次目前狀態無法預作`); Object.assign(f, { status: 'prepared', prepared_at: t, prepared_by: s.name });
      if ((extra.via_scan || extra.from_prep) && !extra.force_date) {
        const st = DB.rx_stores.find(x => x.id === f.store_id);
        if (!st.settings.last_prep_date || st.settings.last_prep_date < f.due_date) st.settings.last_prep_date = f.due_date;
      }
      break;
    case 'unprepare': if (f.status !== 'prepared') fail('只有「已預作」可以取消預作'); Object.assign(f, { status: 'pending', prepared_at: null, prepared_by: null }); break;
    case 'notify': if (!['prepared', 'notified'].includes(f.status)) fail('請先完成預作再通知'); Object.assign(f, { status: 'notified', notified_at: t, notified_by: s.name, notified_via: extra.via || f.notified_via }); break;
    case 'unnotify': if (f.status !== 'notified') fail('只有「已通知」可以撤銷通知'); Object.assign(f, { status: 'prepared', notified_at: null, notified_by: null, notified_via: null }); break;
    case 'pickup': if (!['prepared', 'notified'].includes(f.status)) fail('尚未預作，不能標記領取'); Object.assign(f, { status: 'picked', picked_at: t, picked_by: s.name }); break;
    case 'unpickup': if (f.status !== 'picked') fail('只有「已領取」可以撤銷'); Object.assign(f, { status: f.notified_at ? 'notified' : 'prepared', picked_at: null, picked_by: null }); break;
    case 'cancel': if (f.status === 'picked') fail('已領取不能取消'); f.status = 'cancelled'; break;
    case 'restore': if (f.status !== 'cancelled') fail('只有已取消可以復原');
      Object.assign(f, { status: 'pending', prepared_at: null, prepared_by: null, notified_at: null, notified_by: null, notified_via: null });
      if (o.status === 'cancelled') o.status = 'active'; break;
    default: fail('未知的動作 ' + action);
  }
  log(o, f, action, { seq: f.seq, due_date: f.due_date, ...extra }, s);
  refresh(DB, o.id);
  return { fill_id: f.id, status: f.status };
}
const orderWithFills = o => ({ ...o, fills: DB.rx_fills.filter(f => f.order_id === o.id).sort((a, b) => a.seq - b.seq) });

const RPC = {
  rx_is_admin: () => isAdmin(),
  rx_my_store: () => myStore(),
  rx_create_order({ p, p_staff }) {
    const sid = p.store_id || myStore();
    if (!canStore(sid)) fail('沒有此門市的權限');
    validate(p);
    const s = staffOrFail(sid, p_staff);
    if (p.family_no && !DB.rx_orders.some(x => x.order_no === p.family_no && x.store_id === sid)) fail('找不到同行家人的寄單 ' + p.family_no);
    const d = today();
    DB.counters[d] = (DB.counters[d] || 0) + 1;
    const base = d.replace(/-/g, '').slice(2) + String(DB.counters[d]).padStart(4, '0');
    const o = {
      id: ++DB.seq.rx_orders, order_no: base + luhn(base), store_id: sid, patient_name: p.patient_name.trim(), phone: p.phone || null,
      notify_methods: p.notify_methods, note: (p.note || '').trim() || null,
      hospital_code: p.hospital_code || null, hospital_name: nameOf(hospitals(), p.hospital_code) || p.hospital_name || null,
      dept_code: p.dept_code || null, dept_name: nameOf(departments(), p.dept_code) || p.dept_name || null,
      ext_patient_id: p.ext_patient_id || null, status: 'active', created_staff_code: s.code, created_staff_name: s.name,
      created_by: sessionUser, created_at: nowTs(), updated_at: nowTs(),
      birth_date: p.birth_date || null, family_no: p.family_no || null,
    };
    DB.rx_orders.push(o);
    if (p.family_no) { const h = DB.rx_orders.find(x => x.order_no === p.family_no); if (h && !h.family_no) h.family_no = p.family_no; }
    for (const f of p.fills) DB.rx_fills.push({ id: ++DB.seq.rx_fills, order_id: o.id, store_id: sid, seq: f.seq, due_date: f.due_date, status: 'pending' });
    const { store_id, ...detail } = p;
    log(o, null, 'create', detail, s);
    return { id: o.id, order_no: o.order_no };
  },
  rx_update_order({ p_id, p, p_staff }) {
    const o = DB.rx_orders.find(x => x.id === p_id) || fail('找不到寄單');
    if (!canStore(o.store_id)) fail('沒有此門市的權限');
    if (o.status === 'cancelled') fail('已取消的寄單不能修改');
    validate(p);
    const s = staffOrFail(o.store_id, p_staff);
    const snap = () => ({ ...o, fills: DB.rx_fills.filter(f => f.order_id === o.id).sort((a, b) => a.seq - b.seq).map(f => ({ seq: f.seq, due_date: f.due_date, status: f.status })) });
    const before = JSON.parse(JSON.stringify(snap()));
    Object.assign(o, {
      patient_name: p.patient_name.trim(), phone: p.phone || null, notify_methods: p.notify_methods, note: (p.note || '').trim() || null,
      hospital_code: p.hospital_code || null, hospital_name: nameOf(hospitals(), p.hospital_code) || p.hospital_name || null,
      dept_code: p.dept_code || null, dept_name: nameOf(departments(), p.dept_code) || p.dept_name || null,
      ext_patient_id: p.ext_patient_id || o.ext_patient_id, updated_at: nowTs(),
      birth_date: p.birth_date || null, family_no: 'family_no' in p ? (p.family_no || null) : o.family_no,
    });
    const keep = p.fills.map(f => f.seq);
    for (const nf of p.fills) {
      const f = DB.rx_fills.find(x => x.order_id === o.id && x.seq === nf.seq);
      if (!f) DB.rx_fills.push({ id: ++DB.seq.rx_fills, order_id: o.id, store_id: o.store_id, seq: nf.seq, due_date: nf.due_date, status: 'pending' });
      else if (f.due_date !== nf.due_date) { if (f.status === 'picked') fail(`第 ${f.seq} 次已領取，不能改日期`); f.due_date = nf.due_date; }
    }
    if (DB.rx_fills.some(f => f.order_id === o.id && !keep.includes(f.seq) && f.status === 'picked')) fail('已領取的次數不能移除');
    DB.rx_fills = DB.rx_fills.filter(f => f.order_id !== o.id || keep.includes(f.seq));
    log(o, null, 'edit', { before, after: snap() }, s);
    refresh(DB, o.id);
    return { id: o.id, order_no: o.order_no };
  },
  rx_cancel_order({ p_id, p_staff, p_reason }) {
    const o = DB.rx_orders.find(x => x.id === p_id) || fail('找不到寄單');
    if (!canStore(o.store_id)) fail('沒有此門市的權限');
    const s = staffOrFail(o.store_id, p_staff);
    DB.rx_fills.filter(f => f.order_id === o.id && f.status !== 'picked').forEach(f => { f.status = 'cancelled'; });
    o.status = 'cancelled'; o.updated_at = nowTs();
    log(o, null, 'cancel', { reason: p_reason }, s);
  },
  rx_link_family({ p_order, p_target, p_staff }) {
    const a = DB.rx_orders.find(x => x.id === p_order) || fail('找不到寄單');
    const b = DB.rx_orders.find(x => x.id === p_target) || fail('找不到家人的寄單');
    if (!canStore(a.store_id) || a.store_id !== b.store_id) fail('只能連結同一門市的寄單');
    if (a.id === b.id) fail('不能連結自己');
    const s = staffOrFail(a.store_id, p_staff);
    const g = b.family_no || a.family_no || b.order_no;
    const olds = [a.family_no, b.family_no].filter(Boolean);
    for (const o of DB.rx_orders) if (o.id === a.id || o.id === b.id || (o.family_no && olds.includes(o.family_no))) o.family_no = g;
    log(a, null, 'family', { with: b.order_no, with_name: b.patient_name, family_no: g }, s);
    log(b, null, 'family', { with: a.order_no, with_name: a.patient_name, family_no: g }, s);
    return g;
  },
  rx_unlink_family({ p_order, p_staff }) {
    const a = DB.rx_orders.find(x => x.id === p_order) || fail('找不到寄單');
    if (!canStore(a.store_id)) fail('沒有此門市的權限');
    const s = staffOrFail(a.store_id, p_staff);
    const g = a.family_no; if (!g) return;
    a.family_no = null;
    const rest = DB.rx_orders.filter(o => o.family_no === g);
    if (rest.length === 1) rest[0].family_no = null;
    log(a, null, 'unfamily', { family_no: g }, s);
  },
  rx_log_print({ p_id, p_mode }) { const o = DB.rx_orders.find(x => x.id === p_id); if (o && canStore(o.store_id)) log(o, null, 'print', { mode: p_mode }); },
  rx_fill_action: ({ p_fill_id, p_action, p_staff, p_extra }) => fillAction(p_fill_id, p_action, p_staff, p_extra || {}),
  rx_scan({ p_store, p_code, p_from, p_to, p_staff }) {
    if (!canStore(p_store)) fail('沒有此門市的權限');
    const code = String(p_code || '').replace(/\D/g, '');
    if (!validNo(code)) return { result: 'bad_code', code: p_code };
    const o = DB.rx_orders.find(x => x.order_no === code);
    if (!o) return { result: 'not_found', code };
    if (o.store_id !== p_store) return { result: 'other_store', code, store_id: o.store_id, patient_name: o.patient_name };
    if (o.status === 'cancelled') return { result: 'cancelled', order: o };
    const fs = DB.rx_fills.filter(f => f.order_id === o.id).sort((a, b) => a.due_date < b.due_date ? -1 : 1);
    let f = fs.find(x => x.status === 'pending' && x.due_date >= p_from && x.due_date <= p_to);
    if (f) { fillAction(f.id, 'prepare', p_staff, { via_scan: true }); return { result: 'ok', order: o, fill: { ...f } }; }
    f = fs.find(x => ['prepared', 'notified', 'picked'].includes(x.status) && x.due_date >= p_from && x.due_date <= p_to);
    if (f) return { result: 'already', order: o, fill: f };
    f = fs.filter(x => x.status === 'pending').sort((a, b) => Math.abs(dayDiff(a.due_date, p_from)) - Math.abs(dayDiff(b.due_date, p_from)))[0];
    if (f) return { result: 'other_date', order: o, fill: f };
    return { result: 'no_pending', order: o };
  },
  rx_search({ p }) {
    let sid = p.store_id || null;
    if (!sid && !isAdmin()) sid = myStore();
    if (sid && !canStore(sid)) fail('沒有此門市的權限');
    const has = v => v !== undefined && v !== null && v !== '';
    const kw = (p.keyword || '').trim();
    const ci = (a, b) => String(a || '').toLowerCase().includes(String(b).toLowerCase());
    const out = DB.rx_orders.filter(o => {
      if (sid && o.store_id !== sid) return false;
      if (kw && !(ci(o.patient_name, kw) || ci(o.phone, kw) || o.order_no.startsWith(kw) || ci(o.note, kw))) return false;
      if (has(p.hospital) && !(String(o.hospital_code || '').startsWith(p.hospital) || ci(o.hospital_name, p.hospital))) return false;
      if (has(p.dept_code) && o.dept_code !== p.dept_code) return false;
      if (has(p.staff) && !(o.created_staff_code === p.staff || ci(o.created_staff_name, p.staff))) return false;
      if (has(p.notify) && !o.notify_methods.includes(p.notify)) return false;
      if (has(p.order_status) && o.status !== p.order_status) return false;
      const cd = iso(new Date(o.created_at));
      if (has(p.created_from) && cd < p.created_from) return false;
      if (has(p.created_to) && cd > p.created_to) return false;
      if (has(p.due_from) || has(p.due_to) || has(p.fill_status)) {
        if (!DB.rx_fills.some(f => f.order_id === o.id && (!has(p.due_from) || f.due_date >= p.due_from) && (!has(p.due_to) || f.due_date <= p.due_to) && (!has(p.fill_status) || f.status === p.fill_status))) return false;
      }
      return true;
    }).sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).slice(0, Math.min(p.limit || 300, 2000));
    return out.map(o => ({ ...orderWithFills(o), store_name: DB.rx_stores.find(s => s.id === o.store_id)?.short_name }));
  },
  rx_patient_suggest({ p_store, q }) {
    if (!p_store || !canStore(p_store)) fail('沒有此門市的權限');
    q = String(q || '').trim(); if (!q) return [];
    const seen = new Map();
    for (const o of [...DB.rx_orders].sort((a, b) => (a.created_at < b.created_at ? 1 : -1))) {
      if (o.store_id !== p_store) continue;
      if (!(o.patient_name.includes(q) || String(o.phone || '').startsWith(q))) continue;
      const k = o.patient_name + '|' + (o.birth_date || '') + '|' + (o.phone || '');
      if (seen.has(k)) continue;
      const open = DB.rx_fills.filter(f => ['pending', 'prepared'].includes(f.status) && DB.rx_orders.some(x => x.id === f.order_id && x.store_id === p_store && x.patient_name === o.patient_name && (x.birth_date || '') === (o.birth_date || '') && (x.phone || '') === (o.phone || ''))).length;
      seen.set(k, { patient_name: o.patient_name, phone: o.phone, birth_date: o.birth_date, notify_methods: o.notify_methods, hospital_code: o.hospital_code, hospital_name: o.hospital_name, dept_code: o.dept_code, dept_name: o.dept_name, ext_patient_id: o.ext_patient_id, order_no: o.order_no, created_at: o.created_at, open_fills: open });
    }
    return [...seen.values()].sort((a, b) => (b.patient_name.startsWith(q) - a.patient_name.startsWith(q))).slice(0, 12);
  },
  rx_dashboard({ p_store, p_prep_from, p_prep_to, p_overdue_days }) {
    if (!canStore(p_store)) fail('沒有此門市的權限');
    const t = today();
    const fills = DB.rx_fills.filter(f => f.store_id === p_store);
    const ord = id => DB.rx_orders.find(o => o.id === id);
    const inRange = f => f.due_date >= p_prep_from && f.due_date <= p_prep_to && ord(f.order_id).status !== 'cancelled';
    const selfOnly = o => o.notify_methods.length === 1 && o.notify_methods[0] === '自取';
    return {
      today_orders: DB.rx_orders.filter(o => o.store_id === p_store && iso(new Date(o.created_at)) === t).length,
      prep_pending: fills.filter(f => inRange(f) && f.status === 'pending').length,
      prep_total: fills.filter(f => inRange(f) && f.status !== 'cancelled').length,
      late_pending: fills.filter(f => f.status === 'pending' && f.due_date < p_prep_from).length,
      to_notify: fills.filter(f => f.status === 'prepared' && !selfOnly(ord(f.order_id))).length,
      notified_today: fills.filter(f => f.status === 'notified' && f.notified_at && iso(new Date(f.notified_at)) === t).length,
    };
  },
  rx_due_counts({ p_store, p_from, p_to }) {
    if (!canStore(p_store)) return [];
    const m = {};
    for (const f of DB.rx_fills) {
      if (f.store_id !== p_store || f.due_date < p_from || f.due_date > p_to) continue;
      if (DB.rx_orders.find(o => o.id === f.order_id).status === 'cancelled') continue;
      const x = (m[f.due_date] ||= { due_date: f.due_date, total: 0, pending: 0 });
      if (f.status !== 'cancelled') x.total++;
      if (f.status === 'pending') x.pending++;
    }
    return Object.values(m).sort((a, b) => (a.due_date < b.due_date ? -1 : 1));
  },
  rx_update_store_settings({ p_store, p_settings }) {
    if (!canStore(p_store)) fail('沒有此門市的權限');
    const s = DB.rx_stores.find(x => x.id === p_store);
    s.settings = { ...s.settings, ...p_settings };
    return s.settings;
  },
};

// ---------------------------------------------------------------- 資料表查詢（模擬 PostgREST）
function table(name) {
  load();
  if (name === 'rx_hospitals') return hospitals();
  if (name === 'rx_departments') return departments();
  if (name === 'rx_fill_view') {
    return DB.rx_fills.map(f => {
      const o = DB.rx_orders.find(x => x.id === f.order_id);
      return {
        fill_id: f.id, seq: f.seq, due_date: f.due_date, fill_status: f.status, prepared_at: f.prepared_at, prepared_by: f.prepared_by,
        notified_at: f.notified_at, notified_by: f.notified_by, notified_via: f.notified_via, picked_at: f.picked_at, picked_by: f.picked_by,
        order_id: o.id, order_no: o.order_no, store_id: o.store_id, patient_name: o.patient_name, phone: o.phone, notify_methods: o.notify_methods,
        note: o.note, hospital_code: o.hospital_code, hospital_name: o.hospital_name, dept_code: o.dept_code, dept_name: o.dept_name,
        order_status: o.status, created_at: o.created_at, created_staff_name: o.created_staff_name,
        fill_count: DB.rx_fills.filter(x => x.order_id === o.id).length,
        birth_date: o.birth_date, family_no: o.family_no, created_staff_code: o.created_staff_code,
        max_seq: Math.max(...DB.rx_fills.filter(x => x.order_id === o.id && x.status !== 'cancelled').map(x => x.seq), 0),
      };
    });
  }
  return (DB[name] ||= []);
}
// RLS：門市帳號只看得到自己門市
function rls(name, row) {
  if (isAdmin()) return true;
  const s = myStore();
  if (['rx_orders', 'rx_fills', 'rx_logs', 'rx_fill_view', 'rx_hospital_quick'].includes(name)) return row.store_id === s;
  if (['rx_staff', 'rx_phrases'].includes(name)) return !row.store_id || row.store_id === s;
  if (name === 'rx_users') return row.id === sessionUser;
  return true;
}
const writable = name => isAdmin() || ['rx_hospital_quick', 'rx_phrases'].includes(name);

const cmp = (a, b) => (a === b ? 0 : a == null ? 1 : b == null ? -1 : (typeof a === 'number' && typeof b === 'number') ? a - b : String(a) < String(b) ? -1 : 1);
const likeRe = (pat, ci) => new RegExp('^' + String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', ci ? 'i' : '');
const same = (a, b) => a === b || (a != null && b != null && String(a) === String(b));

class Query {
  constructor(name) { this.name = name; this.filters = []; this.orders = []; this.lim = null; this.mode = 'select'; this.sel = '*'; this.one = 0; }
  select(s = '*') { if (this.mode === 'select') this.sel = s; return this; }
  eq(c, v) { this.filters.push(r => same(r[c], v)); return this; }
  neq(c, v) { this.filters.push(r => !same(r[c], v)); return this; }
  in(c, a) { this.filters.push(r => a.some(v => same(r[c], v))); return this; }
  gte(c, v) { this.filters.push(r => r[c] != null && cmp(r[c], v) >= 0); return this; }
  gt(c, v) { this.filters.push(r => r[c] != null && cmp(r[c], v) > 0); return this; }
  lte(c, v) { this.filters.push(r => r[c] != null && cmp(r[c], v) <= 0); return this; }
  lt(c, v) { this.filters.push(r => r[c] != null && cmp(r[c], v) < 0); return this; }
  is(c, v) { this.filters.push(r => (v === null ? r[c] == null : r[c] === v)); return this; }
  like(c, p) { const re = likeRe(p); this.filters.push(r => re.test(r[c] ?? '')); return this; }
  ilike(c, p) { const re = likeRe(p, true); this.filters.push(r => re.test(r[c] ?? '')); return this; }
  or(expr) {
    const parts = expr.split(',').map(s => { const [c, op, ...v] = s.split('.'); return { c, op, v: v.join('.') }; });
    this.filters.push(r => parts.some(({ c, op, v }) =>
      op === 'eq' ? same(r[c], v) : op === 'is' ? (v === 'null' ? r[c] == null : String(r[c]) === v)
        : op === 'like' ? likeRe(v).test(r[c] ?? '') : op === 'ilike' ? likeRe(v, true).test(r[c] ?? '') : false));
    return this;
  }
  order(c, o = {}) { this.orders.push({ c, asc: o.ascending !== false, nf: o.nullsFirst ?? o.ascending === false }); return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.lim = b + 1; return this; }
  single() { this.one = 1; return this; }
  maybeSingle() { this.one = 2; return this; }
  insert(d) { this.mode = 'insert'; this.data = d; return this; }
  update(d) { this.mode = 'update'; this.data = d; return this; }
  upsert(d, o = {}) { this.mode = 'upsert'; this.data = d; this.conflict = (o.onConflict || 'id').split(','); return this; }
  delete() { this.mode = 'delete'; return this; }
  then(res, rej) { return new Promise(r => setTimeout(r, 30)).then(() => this.run()).then(res, rej); }

  run() {
    try {
      const rows = table(this.name);
      const match = r => rls(this.name, r) && this.filters.every(f => f(r));
      if (this.mode !== 'select') {
        if (!writable(this.name)) return { data: null, error: { message: '權限不足（RLS）' } };
        const pkOf = { rx_stores: ['id'], rx_hospitals: ['code'], rx_departments: ['code'], rx_settings: ['key'], rx_hospital_quick: ['store_id', 'quick_code'] }[this.name] || ['id'];
        const list = [].concat(this.data || []);
        if (this.mode === 'insert' || this.mode === 'upsert') {
          for (const d of list) {
            if (this.name === 'rx_hospital_quick' && !isAdmin() && d.store_id !== myStore()) return { data: null, error: { message: '權限不足（RLS）' } };
            const keys = this.mode === 'upsert' ? this.conflict : pkOf;
            const ex = rows.find(r => keys.every(k => same(r[k], d[k])) && keys.every(k => d[k] !== undefined));
            if (ex) { if (this.mode === 'insert') return { data: null, error: { message: '資料重複（代碼已存在）' } }; Object.assign(ex, d); }
            else {
              const row = { ...d };
              if (pkOf[0] === 'id' && row.id === undefined) row.id = DB.seq[this.name] = (DB.seq[this.name] || rows.length) + 1;
              if (this.name === 'rx_stores') row.settings ||= {};
              rows.push(row);
            }
          }
        } else if (this.mode === 'update') {
          rows.filter(match).forEach(r => Object.assign(r, this.data));
        } else if (this.mode === 'delete') {
          const keep = rows.filter(r => !match(r));
          rows.length = 0; rows.push(...keep);
        }
        if (this.name === 'rx_hospitals') {
          DB.hospOverrides ||= {};
          for (const d of list.length ? list : rows.filter(match)) DB.hospOverrides[d.code] = { ...(DB.hospOverrides[d.code] || {}), ...d };
        }
        save();
        return { data: null, error: null };
      }
      let out = rows.filter(match);
      if (this.orders.length) out = [...out].sort((a, b) => {
        for (const o of this.orders) {
          const x = a[o.c], y = b[o.c];
          if (x == null && y == null) continue;
          if (x == null || y == null) return (x == null ? -1 : 1) * (o.nf ? 1 : -1);
          const c = cmp(x, y) * (o.asc ? 1 : -1);
          if (c) return c;
        }
        return 0;
      });
      if (this.lim != null) out = out.slice(0, this.lim);
      out = out.map(r => this.embed(JSON.parse(JSON.stringify(r))));
      if (this.one) {
        if (!out.length && this.one === 1) return { data: null, error: { message: '找不到資料' } };
        return { data: out[0] ?? null, error: null };
      }
      return { data: out, error: null };
    } catch (e) { return { data: null, error: { message: e.message } }; }
  }
  embed(r) {
    if (this.sel.includes('rx_fills(')) {
      const k = (this.sel.match(/(\w+):rx_fills\(/) || [])[1] || 'rx_fills';
      r[k] = DB.rx_fills.filter(f => f.order_id === r.id).sort((a, b) => a.seq - b.seq);
    }
    if (this.sel.includes('rx_hospitals(')) r.rx_hospitals = { name: hospitals().find(h => h.code === r.hospital_code)?.name };
    return r;
  }
}

// ---------------------------------------------------------------- client
const listeners = [];
export function createClient() {
  load();
  sessionUser = store.get(SKEY);
  if (sessionUser && !DB.rx_users.some(u => u.id === sessionUser)) sessionUser = null;
  injectDemoUi();
  const emit = (ev, s) => listeners.forEach(cb => { try { cb(ev, s); } catch { /* ignore */ } });
  const session = () => (sessionUser ? { user: { id: sessionUser } } : null);
  return {
    auth: {
      getSession: async () => ({ data: { session: session() }, error: null }),
      onAuthStateChange(cb) { listeners.push(cb); return { data: { subscription: { unsubscribe() { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); } } } }; },
      async signInWithPassword({ email }) {
        const acc = String(email).split('@')[0].toLowerCase();
        const u = DB.rx_users.find(x => x.account === acc);
        if (!u) return { data: null, error: { message: 'Invalid login credentials' } };
        sessionUser = u.id; store.set(SKEY, u.id);
        setTimeout(() => emit('SIGNED_IN', session()), 0);
        return { data: { session: session() }, error: null };
      },
      async signOut() { sessionUser = null; store.del(SKEY); setTimeout(() => emit('SIGNED_OUT', null), 0); return { error: null }; },
    },
    from: name => new Query(name),
    async rpc(name, args = {}) {
      await new Promise(r => setTimeout(r, 40));
      const fn = RPC[name];
      if (!fn) return { data: null, error: { message: `試用版未支援 ${name}` } };
      if (!sessionUser) return { data: null, error: { message: 'JWT expired' } };
      try { const data = fn(args); save(); return { data: data ?? null, error: null }; }
      catch (e) { return { data: null, error: { message: e.message } }; }
    },
    functions: {
      async invoke(fn, { body }) {
        if (!isAdmin()) return { data: { error: '只有管理員可以管理帳號' }, error: null };
        const acc = String(body.account || '').trim().toLowerCase();
        if (body.action === 'create') {
          if (DB.rx_users.some(u => u.account === acc)) return { data: { error: '帳號已存在' }, error: null };
          DB.rx_users.push({ id: 'u-' + acc, account: acc, display_name: body.display_name || acc, role: body.role === 'admin' ? 'admin' : 'store', store_id: body.store_id || null, active: true });
          save(); return { data: { ok: true }, error: null };
        }
        if (body.action === 'reset_password') return DB.rx_users.some(u => u.account === acc) ? { data: { ok: true }, error: null } : { data: { error: '找不到此帳號' }, error: null };
        return { data: { error: '未知的動作' }, error: null };
      },
    },
  };
}

// ---------------------------------------------------------------- 試用版提示列
function injectDemoUi() {
  if (typeof document === 'undefined' || document.getElementById('demo-bar')) return;
  const css = document.createElement('style');
  css.textContent = `#demo-bar{position:fixed;left:12px;bottom:12px;z-index:70;background:#fff2e3;color:#7a3d00;border:1.5px solid #ff9933;border-radius:16px;padding:8px 12px;font:13px/1.5 "Chiron GoRound TC","Microsoft JhengHei",sans-serif;box-shadow:0 10px 24px -12px rgba(0,0,0,.3);max-width:330px}
  #demo-bar b{color:#00201f}#demo-bar button{font:inherit;font-weight:700;border:1.2px solid #b35a00;background:#fff;color:#b35a00;border-radius:99px;padding:0 10px;cursor:pointer;margin-left:4px}
  #demo-bar .x{border:0;background:none;padding:0 2px;margin:0;float:right}#demo-bar details{margin-top:4px}#demo-bar code{background:#fff;border-radius:6px;padding:0 4px}`;
  document.head.appendChild(css);
  const bar = document.createElement('div');
  bar.id = 'demo-bar';
  bar.innerHTML = `<button class="x" title="收合">✕</button><b>試用版</b>：資料只存在這台電腦的瀏覽器 <button data-reset>重置示範資料</button>
    <details open><summary>帳號與人員代碼</summary>
    登入（密碼隨意）：<code>admin</code> 管理員、<code>fuyuan</code> 福原、<code>rixin</code> 日新、<code>boya</code> 博亞<br>
    人員代碼：福原 <code>11</code> 王藥師、<code>12</code> 陳助理、<code>13</code> 黃藥師；日新 <code>21</code>；博亞 <code>31</code>；通用 <code>99</code> Tom<br>
    預作頁可直接輸入寄單編號模擬刷條碼（在查詢頁或明細可看到編號）。本地藥局系統連線在試用版無作用。</details>`;
  bar.querySelector('.x').onclick = () => { bar.style.display = 'none'; };
  // 登入頁展開帳號說明；登入後自動收合，避免擋到按鈕
  const det = bar.querySelector('details');
  let touched = false;
  det.addEventListener('click', () => { touched = true; });
  let lastNav = null;
  setInterval(() => {
    const nav = !!document.querySelector('.nav');
    if (nav !== lastNav) { lastNav = nav; touched = false; }
    if (!touched) det.open = !nav;
  }, 500);
  bar.querySelector('[data-reset]').onclick = () => { if (confirm('清除所有試用資料並重建示範資料？')) { resetDemo(); location.reload(); } };
  const add = () => document.body.appendChild(bar);
  document.body ? add() : document.addEventListener('DOMContentLoaded', add);
}
