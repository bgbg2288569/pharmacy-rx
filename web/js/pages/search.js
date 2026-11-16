// 寄單查詢：多條件、模糊搜尋、欄位排序（表格不換行，過長以 … 顯示，滑鼠移上可看全文）
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { state, rpc, toast, toastErr, todayISO, addDays, rocOf, fullOf, dtOf, fmtNo, isAdmin, storeSetting, shortHosp, ageOf, FILL_STATUS, ORDER_STATUS, withBusy } from '../lib.js';
import { RocDate, FillChip, NotifyPills, DeptInput } from '../components.js';
import { printList, printOrder } from '../print.js';

// 「狀態」合併成一個選單：寄單整張的狀態 + 某一次領藥的狀態
const STATUS_OPTS = [
  { v: '', t: '全部' },
  { v: 'active', t: '進行中', p: { order_status: 'active' } },
  { v: 'pending', t: '有寄放中', p: { fill_status: 'pending' } },
  { v: 'prepared', t: '已預作待通知', p: { fill_status: 'prepared' } },
  { v: 'closed', t: '已完成', p: { order_status: 'closed' } },
  { v: 'cancelled', t: '已取消', p: { order_status: 'cancelled' } },
];
const blank = () => ({ keyword: '', hospital: '', dept_code: '', dept_name: '', status: '', created_from: '', created_to: '', due_from: '', due_to: '', all_stores: false });

export default {
  components: { RocDate, FillChip, NotifyPills, DeptInput },
  setup() {
    // 查詢條件／排序保留在 state.searchSaved：切換頁面回來還在，登出或重新整理才清空
    const saved = state.searchSaved;
    const f = reactive(saved ? { ...blank(), ...saved.f } : blank());
    const rows = ref([]);
    const loading = ref(false);
    const searched = ref(false);
    const sort = reactive(saved ? { ...saved.sort } : { key: 'created_at', dir: -1 });
    watch([f, sort], () => { state.searchSaved = { f: { ...f }, sort: { ...sort } }; }, { deep: true });
    const kwEl = ref(null);

    // 輸入條件即時查詢：停止輸入 0.35 秒後自動查；相同條件不重查；較慢回來的舊結果不覆蓋新結果
    let timer = 0, seq = 0, lastKey = '';
    const params = () => {
      const { status, all_stores, ...rest } = f;
      return { ...rest, ...(STATUS_OPTS.find(x => x.v === status)?.p || {}), store_id: all_stores && isAdmin() ? '' : state.storeId, limit: 1000 };
    };
    async function run(force = true) {
      clearTimeout(timer);
      const p = params();
      const key = JSON.stringify(p);
      if (!force && key === lastKey) return;
      lastKey = key;
      const my = ++seq;
      loading.value = true;
      try {
        const r = await withBusy(rpc('rx_search', { p }), '搜尋中…');
        if (my === seq) { rows.value = r; searched.value = true; }
      } catch (e) { if (my === seq) toastErr(e); } finally { if (my === seq) loading.value = false; }
    }
    // 沒有任何條件時列出全部（含已取消），依寄單時間由新到舊
    watch(f, () => {
      clearTimeout(timer);
      timer = setTimeout(() => run(false), 350);
    }, { deep: true });
    function clear() { Object.assign(f, blank()); kwEl.value?.focus(); }
    function preset(k) {
      Object.assign(f, blank());
      const t = todayISO();
      if (k === 'today') { f.created_from = t; f.created_to = t; }
      if (k === 'week') { f.due_from = t; f.due_to = addDays(t, 7); }
      if (k === 'prep') { const d = addDays(t, Number(storeSetting('prep_days_ahead', 7))); f.due_from = d; f.due_to = d; }
      if (k === 'open') f.status = 'active';
      if (k === 'notify') f.status = 'prepared';
      run();
    }

    const nextDue = o => (o.fills || []).filter(x => ['pending', 'prepared'].includes(x.status)).map(x => x.due_date).sort()[0] || '9999';
    const val = (o, k) => (k === 'next_due' ? nextDue(o) : k === 'staff' ? (o.created_staff_code || '') : (o[k] ?? ''));
    const sorted = computed(() => {
      const k = sort.key, d = sort.dir;
      return [...rows.value].sort((a, b) => { const x = val(a, k), y = val(b, k); return (x > y ? 1 : x < y ? -1 : 0) * d; });
    });
    function by(k) { if (sort.key === k) sort.dir *= -1; else { sort.key = k; sort.dir = 1; } }
    const ar = k => (sort.key === k ? (sort.dir > 0 ? '▲' : '▼') : '');
    const staffOf = o => [o.created_staff_code, o.created_staff_name].filter(Boolean).join(' ');

    function exportPrint() {
      printList('寄單查詢結果', [
        { label: '寄單編號', get: r => fmtNo(r.order_no) }, { label: '寄單日', get: r => dtOf(r.created_at) },
        { label: '姓名', key: 'patient_name' }, { label: '生日', get: r => fullOf(r.birth_date) }, { label: '電話', key: 'phone' },
        { label: '醫院', get: r => shortHosp(r.hospital_code, r.hospital_name) }, { label: '科別', key: 'dept_name' },
        { label: '領藥', get: r => (r.fills || []).map(x => `${x.seq}:${rocOf(x.due_date)}${FILL_STATUS[x.status]}`).join(' ') },
        { label: '人員', get: staffOf }, { label: '備註', key: 'note' },
      ], sorted.value);
    }
    function exportCsv() {
      const head = ['寄單編號', '門市', '寄單時間', '姓名', '生日', '電話', '通知方式', '醫院代號', '醫院', '科別', '第1次', '狀態1', '第2次', '狀態2', '第3次', '狀態3', '備註', '輸入人員代號', '輸入人員', '同行家人', '寄單狀態'];
      const fc = (r, s) => { const x = (r.fills || []).find(y => y.seq === s); return x ? [fullOf(x.due_date), FILL_STATUS[x.status]] : ['', '']; };
      const lines = sorted.value.map(r => [r.order_no, r.store_name, new Date(r.created_at).toLocaleString('zh-TW'), r.patient_name, fullOf(r.birth_date), r.phone,
        (r.notify_methods || []).join('、'), r.hospital_code, r.hospital_name, r.dept_name, ...fc(r, 1), ...fc(r, 2), ...fc(r, 3), r.note,
        r.created_staff_code, r.created_staff_name, r.family_no, ORDER_STATUS[r.status]]);
      const csv = [head, ...lines].map(l => l.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
      a.download = `寄單查詢_${todayISO()}.csv`; a.click();
    }

    watch(() => state.tick, () => { if (searched.value) run(); });
    watch(() => state.storeId, () => { if (searched.value) run(); });
    onMounted(() => {
      kwEl.value?.focus();
      run();                              // 預設「全部」（含已取消）；回到本頁時用保留的條件重新查一次
    });
    // 清單上快速補印貼紙（固定用 4×3 貼紙格式）
    function quickLabel(o) { printOrder(o, o.fills, 'label'); toast(`已送出補印貼紙：${o.patient_name}`, 'ok', 1500); }
    const open = id => { state.detailId = id; };
    return { quickLabel, state, f, rows, sorted, loading, searched, run, clear, preset, by, ar, open, kwEl, exportPrint, exportCsv, staffOf,
      isAdmin, rocOf, fullOf, dtOf, fmtNo, shortHosp, ageOf, ORDER_STATUS, STATUS_OPTS };
  },
  template: `<div class="wrap wide">
    <div class="page-head"><h2><i class="sl"></i>寄單查詢</h2><span class="sp"></span>
      <div class="chips">
        <button class="chip" @click="preset('all')">全部</button>
        <button class="chip" @click="preset('open')">進行中</button>
        <button class="chip" @click="preset('today')">今日寄單</button>
        <button class="chip" @click="preset('prep')">預作日到期</button>
        <button class="chip" @click="preset('week')">7 天內到期</button>
        <button class="chip" @click="preset('notify')">已預作待通知</button>
      </div>
    </div>
    <div class="card qgrid" @keydown.enter="run()">
      <div class="q kw"><label class="lbl">關鍵字 <span class="opt">姓名／電話／寄單編號／備註</span></label>
        <input ref="kwEl" class="inp" v-model="f.keyword" placeholder="例：王小明、0912、261113" autocomplete="off"></div>
      <div class="q hp"><label class="lbl">醫院 <span class="opt">名稱或院所代號</span></label><input class="inp" v-model="f.hospital" placeholder="例：台大、0401180014"></div>
      <div class="q dp"><label class="lbl">科別</label><DeptInput v-model:code="f.dept_code" v-model:name="f.dept_name" /></div>
      <div class="q st"><label class="lbl">狀態</label>
        <select class="inp" v-model="f.status"><option v-for="o in STATUS_OPTS" :key="o.v" :value="o.v">{{o.t}}</option></select></div>
      <div class="q rg1"><label class="lbl">寄單日</label>
        <div class="rg"><RocDate v-model="f.created_from" placeholder="起" compact /><span>～</span><RocDate v-model="f.created_to" placeholder="迄" compact /></div></div>
      <div class="q rg2"><label class="lbl">領藥日</label>
        <div class="rg"><RocDate v-model="f.due_from" placeholder="起" compact /><span>～</span><RocDate v-model="f.due_to" placeholder="迄" compact /></div></div>
      <div class="q bt">
        <label v-if="isAdmin()" class="small" style="display:flex;gap:6px;align-items:center"><input type="checkbox" v-model="f.all_stores">全部門市</label>
        <button class="btn ghost" @click="clear">清除條件</button>
        <button class="btn fill" @click="run()" :disabled="loading"><i class="sl"></i>查詢</button>
      </div>
    </div>

    <div class="card">
      <div class="btns" style="margin-bottom:8px">
        <b>{{ searched ? '共 ' + rows.length + ' 筆' : '' }}</b><span class="small muted" v-if="rows.length>=1000">（只顯示前 1000 筆，請縮小條件）</span>
        <span class="legend"><span class="sq sq1">1</span><span class="sq sq2">2</span><span class="sq sq3">3</span>領藥次數
          <span class="fc pending">寄放中</span><span class="fc prepared">已預作</span><span class="fc notified">已通知</span><span class="fc cancelled">已取消</span>
          <span class="fc pending late">過期未預作</span></span>
        <span style="flex:1"></span>
        <button class="btn sm" :disabled="!rows.length" @click="exportPrint">列印清單</button>
        <button class="btn sm" :disabled="!rows.length" @click="exportCsv">匯出 CSV</button>
      </div>
      <div class="tbl fixed stbl" style="max-height:calc(100vh / var(--z,1) - 290px)"><table>
        <thead><tr>
          <th style="width:46px" title="補印貼紙">貼紙</th>
          <th class="sort" v-if="f.all_stores" @click="by('store_name')">門市<span class="ar">{{ar('store_name')}}</span></th>
          <th class="sort" @click="by('created_at')">寄單時間<span class="ar">{{ar('created_at')}}</span></th>
          <th class="sort" @click="by('patient_name')">姓名<span class="ar">{{ar('patient_name')}}</span></th>
          <th class="sort" @click="by('birth_date')">生日<span class="ar">{{ar('birth_date')}}</span></th>
          <th class="sort" @click="by('phone')">電話<span class="ar">{{ar('phone')}}</span></th>
          <th>通知</th>
          <th class="sort" @click="by('hospital_name')">醫院<span class="ar">{{ar('hospital_name')}}</span></th>
          <th class="sort" @click="by('dept_name')">科別<span class="ar">{{ar('dept_name')}}</span></th>
          <th class="sort" @click="by('next_due')">領藥日<span class="ar">{{ar('next_due')}}</span></th>
          <th>備註</th>
          <th class="sort" @click="by('staff')">輸入人員<span class="ar">{{ar('staff')}}</span></th>
          <th class="sort" @click="by('status')">狀態<span class="ar">{{ar('status')}}</span></th>
          <th class="sort" @click="by('order_no')">寄單編號<span class="ar">{{ar('order_no')}}</span></th>
        </tr></thead>
        <tbody>
          <tr v-for="o in sorted" :key="o.id" @click="open(o.id)" :class="{done:o.status!=='active'}">
            <td class="pr"><button class="btn xs prbtn" title="補印 4×3 貼紙" @click.stop="quickLabel(o)">🖨</button></td>
            <td v-if="f.all_stores"><span class="pill store">{{o.store_name}}</span></td>
            <td class="lt">{{dtOf(o.created_at)}}</td>
            <td style="--mw:130px" :title="o.patient_name"><span class="t">{{o.patient_name}}</span><span class="famic" v-if="o.family_no" title="有同行家人">👪</span></td>
            <td class="lt" :title="o.birth_date ? '民國 '+fullOf(o.birth_date) : ''">{{fullOf(o.birth_date)}}</td>
            <td class="lt">{{o.phone}}</td>
            <td><NotifyPills :list="o.notify_methods" /></td>
            <td style="--mw:150px" :title="o.hospital_name"><b>{{shortHosp(o.hospital_code, o.hospital_name)}}</b></td>
            <td style="--mw:120px" :title="o.dept_name"><b>{{o.dept_name}}</b></td>
            <td class="fills3"><span style="display:flex;gap:4px"><FillChip v-for="x in o.fills" :key="x.id" :f="x" /></span></td>
            <td class="small" style="--mw:260px;min-width:160px" :title="o.note">{{o.note}}</td>
            <td class="small" style="--mw:110px" :title="staffOf(o)">{{o.created_staff_code}} {{o.created_staff_name}}</td>
            <td><span class="pill os" :class="'os-'+o.status">{{ORDER_STATUS[o.status]}}</span></td>
            <td class="lt">{{fmtNo(o.order_no)}}</td>
          </tr>
          <tr class="empty-row" v-if="searched && !rows.length"><td colspan="14">查無符合條件的寄單</td></tr>
        </tbody>
      </table></div>
    </div>
  </div>`,
};
