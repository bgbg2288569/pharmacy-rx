// 預作確認：刷寄單條碼自動比對，或手動點選
import { ref, reactive, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import {
  sb, state, q, rpc, toast, toastErr, beep, todayISO, addDays, rocOf, mdOf, weekOf, fmtNo, dtOf, timeOf, validOrderNo,
  ensureOperator, askStaff, setOperator, storeSetting, bump, CIRCLED, shortHosp, fullOf,
} from '../lib.js';
import { RocDate, NotifyPills } from '../components.js';
import { printList } from '../print.js';

const DAYS = 10;   // 上方日期標籤顯示天數

export default {
  components: { RocDate, NotifyPills },
  setup() {
    const ahead = () => Number(storeSetting('prep_days_ahead', 7));
    const range = reactive({ from: addDays(todayISO(), ahead()), to: addDays(todayISO(), ahead()) });
    const rows = ref([]);
    const late = ref([]);                 // 今天以前仍未預作（提醒用）
    const lastPrep = ref('');              // 目前最新預作日
    const days = ref([]);
    const tab = ref('todo');
    const scan = ref('');
    const scanEl = ref(null);
    const msg = ref({ kind: 'idle', title: '請刷寄單條碼', sub: '或點選下方清單手動確認' });
    const pendingConfirm = ref(null);
    const flashId = ref(null);
    const recent = ref([]);
    const sortKey = ref('order_no');
    const kw = ref('');

    async function load() {
      if (!state.storeId || !range.from) return;
      if (!range.to || range.to < range.from) range.to = range.from;
      try {
        const [list, lt, dc] = await Promise.all([
          q(sb.from('rx_fill_view').select('*').eq('store_id', state.storeId).neq('order_status', 'cancelled').neq('fill_status', 'cancelled')
            .gte('due_date', range.from).lte('due_date', range.to).order('order_no').limit(1000)),
          q(sb.from('rx_fill_view').select('fill_id,due_date').eq('store_id', state.storeId).neq('order_status', 'cancelled').eq('fill_status', 'pending')
            .lt('due_date', todayISO()).gte('due_date', addDays(todayISO(), -60)).order('due_date').limit(300)),
          rpc('rx_due_counts', { p_store: state.storeId, p_from: todayISO(), p_to: addDays(todayISO(), DAYS - 1) }),
          q(sb.from('rx_stores').select('settings').eq('id', state.storeId).single()),
        ]).then(r => { lastPrep.value = r[3]?.settings?.last_prep_date || ''; return r; });
        rows.value = list; late.value = lt;
        const m = Object.fromEntries(dc.map(d => [d.due_date, d]));
        days.value = Array.from({ length: DAYS }, (_, i) => { const d = addDays(todayISO(), i); return { d, total: m[d]?.total || 0, pending: m[d]?.pending || 0 }; });
      } catch (e) { toastErr(e); }
    }
    watch(() => [state.storeId, state.tick, range.from, range.to], load);
    onMounted(() => { load(); focusScan(); });

    const done = computed(() => rows.value.filter(r => r.fill_status !== 'pending'));
    const todo = computed(() => rows.value.filter(r => r.fill_status === 'pending'));
    const shown = computed(() => {
      const base = tab.value === 'todo' ? todo.value : tab.value === 'done' ? done.value : rows.value;
      const k = sortKey.value;
      const w = kw.value.trim().toLowerCase().replace(/-/g, '');
      const hit = r => !w || [r.patient_name, r.phone, r.order_no, r.hospital_name, shortHosp(r.hospital_code, r.hospital_name), r.dept_name, r.dept_code, r.note, fullOf(r.birth_date)]
        .some(v => String(v || '').toLowerCase().includes(w));
      return base.filter(hit).sort((a, b) => String(a[k] ?? '').localeCompare(String(b[k] ?? ''), 'zh-Hant'));
    });
    const pct = computed(() => (rows.value.length ? Math.round(done.value.length / rows.value.length * 100) : 0));

    // 條碼欄只能輸入數字和 -
    function onScanInput(e) { const v = e.target.value.replace(/[^\d-]/g, ''); if (v !== e.target.value) e.target.value = v; scan.value = v; }
    function focusScan() { nextTick(() => scanEl.value?.focus()); }
    function setDay(d) { range.from = d; range.to = d; tab.value = 'todo'; focusScan(); }
    function showLate() { if (!late.value.length) return; range.from = late.value[0].due_date; range.to = addDays(todayISO(), -1); tab.value = 'todo'; }
    const allDone = computed(() => rows.value.length > 0 && todo.value.length === 0);
    function show(kind, title, sub = '') { msg.value = { kind, title, sub }; }
    function pushRecent(text, kind) { recent.value.unshift({ t: new Date(), text, kind }); recent.value = recent.value.slice(0, 30); }
    function flash(fillId) { flashId.value = fillId; setTimeout(() => { if (flashId.value === fillId) flashId.value = null; }, 1300); }

    // ---- 異常警示：跳出警示框，必須用滑鼠點按鈕才能解除 ----
    // 警示期間鍵盤（含掃描槍）輸入一律攔下不處理，避免連續刷條碼時把異常處方刷過去
    const alarm = ref(null);          // { kind, title, sub, hint, fill }
    const ignored = ref(0);           // 警示期間被攔下的刷條碼次數
    let alarmTimer = 0;
    function raiseAlarm(kind, title, sub, hint = '', fill = null, icon = '', repeat = true) {
      alarm.value = { kind, title, sub, hint, fill, icon };
      ignored.value = 0;
      scanEl.value?.blur();
      clearInterval(alarmTimer);
      beep('err');
      if (repeat) alarmTimer = setInterval(() => beep('err'), 3000);   // 未解除前每 3 秒再響一次
    }
    function clearAlarm() { clearInterval(alarmTimer); alarm.value = null; focusScan(); }
    // 只接受真正的滑鼠點擊（鍵盤 Enter／空白鍵觸發的 click，detail 為 0，不算）
    const byMouse = e => e && e.detail > 0;
    function dismissAlarm(e) { if (!byMouse(e)) return; pendingConfirm.value = null; clearAlarm(); }
    async function alarmForce(e) {
      if (!byMouse(e)) return;
      clearInterval(alarmTimer);
      alarm.value = null;
      await forceConfirm();
    }
    function onKeyCapture(e) {
      if (!alarm.value) return;
      if (e.key === 'Enter') ignored.value++;
      if (e.key.length === 1 || ['Enter', 'Escape', 'Tab', ' ', 'Backspace'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
    }
    onMounted(() => window.addEventListener('keydown', onKeyCapture, true));
    onUnmounted(() => { window.removeEventListener('keydown', onKeyCapture, true); clearInterval(alarmTimer); });

    // 同一張寄單有兩次以上領藥日的「日」相同（例：11/24、12/24），實體藥袋會歸檔在同一格，容易拿錯 → 提醒核對處方日期
    async function sameDayCheck(o, f) {
      if (!f?.due_date || !(o?.id || f.order_id)) return;
      try {
        const fills = await q(sb.from('rx_fills').select('seq,due_date,status').eq('order_id', o.id || f.order_id).neq('status', 'cancelled'));
        const dd = f.due_date.slice(8, 10);
        const same = fills.filter(x => x.due_date && x.due_date.slice(8, 10) === dd).sort((a, b) => a.seq - b.seq);
        if (same.length < 2 || alarm.value) return;
        const n = same.length === 2 ? '兩' : same.length === 3 ? '三' : String(same.length);
        const seqs = same.map(x => '第' + x.seq + '次 ' + mdOf(x.due_date)).join('、');
        raiseAlarm('warn', `注意：${o.patient_name || ''} ${n}次預作日期相同`, seqs,
          `${n}次預作日期相同，請確認手上處方日期是否為 ${mdOf(f.due_date)}`, null, '⚠', false);
      } catch { /* 查不到就不提醒，不影響預作 */ }
    }
    async function onScan() {
      if (alarm.value) return;
      const code = scan.value.replace(/\D/g, '');
      scan.value = '';
      pendingConfirm.value = null;
      if (!code) return;
      const op = await ensureOperator();
      focusScan();
      if (!op) return;
      if (!validOrderNo(code)) {
        show('err', '條碼無法辨識', `${code}（檢核碼不符）`); pushRecent(code + ' 條碼錯誤', 'err');
        raiseAlarm('err', '條碼無法辨識', code, '檢核碼不符，請重刷或手動輸入編號'); return;
      }
      try {
        const r = await rpc('rx_scan', { p_store: state.storeId, p_code: code, p_from: range.from, p_to: range.to, p_staff: op.code });
        const o = r.order || {}, f = r.fill || {};
        const who = `${o.patient_name || ''}　${f.seq ? '第' + f.seq + '次 ' + rocOf(f.due_date, true) : ''}`;
        const hd = `${shortHosp(o.hospital_code, o.hospital_name)} ${o.dept_name || ''}`;
        switch (r.result) {
          case 'ok': show('ok', who, `${hd} · 已確認預作`); beep('ok'); pushRecent(who, 'ok'); flash(f.id); bump(); sameDayCheck(o, f); break;
          case 'already': {
            const t = `已確認過（${dtOf(f.prepared_at)} ${f.prepared_by || ''}）`;
            show('warn', who, t); pushRecent(who + ' 重複', 'warn'); flash(f.id);
            raiseAlarm('warn', '重複刷到：' + who, `${hd} · ${t}`, '請確認是否有兩張相同的貼紙，或這包藥已經放過'); break;
          }
          case 'other_date': {
            const t = `領藥日不在 ${rocOf(range.from)}${range.to !== range.from ? '～' + rocOf(range.to) : ''} 清單內`;
            show('warn', who, t); pendingConfirm.value = { ...f, _name: o.patient_name }; pushRecent(who + ' 日期不符', 'warn');
            raiseAlarm('warn', '日期不符：' + who, `${hd} · ${t}`, '請確認是否拿錯日期的處方；確定要預作才按「仍要確認」', f); break;
          }
          case 'no_pending':
            show('err', o.patient_name, '此寄單已沒有待預作的次數'); pushRecent(o.patient_name + ' 無待預作', 'err');
            raiseAlarm('err', '沒有待預作：' + o.patient_name, `${hd} · ${fmtNo(o.order_no)}`, '這張寄單的每一次都已預作或已通知，請確認這包藥'); break;
          case 'cancelled':
            show('err', o.patient_name, '此寄單已取消'); pushRecent(o.patient_name + ' 已取消', 'err');
            raiseAlarm('err', '已取消的寄單：' + o.patient_name, `${hd} · ${fmtNo(o.order_no)}`, '此張寄單已經取消，請勿預作'); break;
          case 'other_store':
            show('err', r.patient_name, `這是其他門市（${r.store_id}）的寄單`); pushRecent((r.patient_name || '') + ' 他店', 'err');
            raiseAlarm('err', '其他門市的寄單：' + (r.patient_name || ''), `門市 ${r.store_id} · ${fmtNo(code)}`, '請把這包藥抽出來，交回所屬門市'); break;
          default:
            show('err', '查無此寄單', fmtNo(code)); pushRecent(code + ' 查無', 'err');
            raiseAlarm('err', '查無此寄單', fmtNo(code), '請確認條碼是否正確，或此寄單是否已被刪除');
        }
      } catch (e) { show('err', '連線錯誤', e.message); raiseAlarm('err', '連線錯誤', e.message, '這次刷的條碼沒有處理，網路恢復後請重刷'); }
    }
    async function forceConfirm() {
      const f = pendingConfirm.value; if (!f) return;
      const op = await ensureOperator(); if (!op) return;
      try {
        await rpc('rx_fill_action', { p_fill_id: f.id, p_action: 'prepare', p_staff: op.code, p_extra: { force_date: true } });
        show('ok', '已確認（日期不同）', `第${f.seq}次 ${rocOf(f.due_date, true)}`); beep('ok'); pendingConfirm.value = null; bump();
        sameDayCheck({ id: f.order_id, patient_name: f._name }, f);
      } catch (e) { toastErr(e); }
      focusScan();
    }
    async function toggle(r) {
      const op = await ensureOperator(); if (!op) return;
      const action = r.fill_status === 'pending' ? 'prepare' : r.fill_status === 'prepared' ? 'unprepare' : null;
      if (!action) { toast('已通知／已領取，請從明細調整', 'warn'); return; }
      if (action === 'unprepare' && !confirm(`取消「${r.patient_name}」第${r.seq}次的預作確認？`)) return;
      try {
        await rpc('rx_fill_action', { p_fill_id: r.fill_id, p_action: action, p_staff: op.code, p_extra: action === 'prepare' ? { from_prep: true } : {} });
        r.fill_status = action === 'prepare' ? 'prepared' : 'pending';
        if (action === 'prepare') { beep('ok'); flash(r.fill_id); sameDayCheck({ id: r.order_id, patient_name: r.patient_name }, { order_id: r.order_id, due_date: r.due_date }); }
        bump();
      } catch (e) { toastErr(e); }
      focusScan();
    }
    async function switchOp() { const s = await askStaff('切換操作人員'); if (s) setOperator(s); focusScan(); }
    function printTodo() {
      printList(`預作未確認清單 ${rocOf(range.from)}${range.to !== range.from ? '～' + rocOf(range.to) : ''}`, [
        { label: '✓', get: () => '' }, { label: '寄單編號', get: r => fmtNo(r.order_no) }, { label: '姓名', key: 'patient_name' },
        { label: '次數', get: r => '第' + r.seq + '次' }, { label: '領藥日', get: r => rocOf(r.due_date) },
        { label: '醫院', key: 'hospital_name' }, { label: '科別', key: 'dept_name' }, { label: '備註', key: 'note' },
      ], todo.value);
    }
    const open = id => { state.detailId = id; };
    return { alarm, ignored, dismissAlarm, alarmForce, state, range, rows, late, lastPrep, showLate, allDone, days, tab, scan, scanEl, msg, pendingConfirm, flashId, recent, sortKey, kw, done, todo, shown, pct, shortHosp, fullOf, timeOf,
      setDay, onScan, onScanInput, forceConfirm, toggle, switchOp, printTodo, open, focusScan, rocOf, mdOf, weekOf, fmtNo, dtOf, todayISO, CIRCLED };
  },
  template: `<div class="wrap">
    <div class="page-head"><h2><i class="sl"></i>預作確認</h2>
      <span class="small muted">把手上的處方箋逐張刷條碼，系統自動比對；也可直接點清單手動確認</span>
      <span class="sp"></span>
      <span class="small lastprep" v-if="lastPrep" title="預作確認後自動更新；寄單時領藥日早於此日會提醒直接調劑">最新預作日 <b class="num">{{fullOf(lastPrep)}}</b></span>
      <span class="small">操作人員：<b>{{state.operator ? state.operator.name : '未設定'}}</b></span>
      <button class="btn sm" @click="switchOp">{{state.operator ? '切換' : '設定'}}</button>
    </div>

    <div class="card">
      <div class="chips" style="margin-bottom:12px;align-items:center">
        <span class="small muted" style="margin-right:4px">領藥日<span class="tiny">（待預作／總數）</span></span>
        <button v-if="late.length" class="chip latechip" @click="showLate" title="今天以前仍未預作的寄單">⚠ 過期未預作 <span class="k">{{late.length}}</span></button>
        <button v-for="x in days" :key="x.d" class="chip" :class="{on: range.from===x.d && range.to===x.d, alldone: x.total>0 && x.pending===0}" @click="setDay(x.d)">
          {{mdOf(x.d)}}({{weekOf(x.d)}}) <span class="k">{{ x.total>0 && x.pending===0 ? '✓ ' + x.total : x.pending + '/' + x.total }}</span></button>
      </div>
      <div class="form" style="align-items:end">
        <div class="fld c3"><label>領藥日 起</label><RocDate v-model="range.from" compact /></div>
        <div class="fld c3"><label>迄 <span class="opt">遇假日可一次做多天</span></label><RocDate v-model="range.to" compact /></div>
        <div class="fld c6"><label>確認進度</label>
          <div class="progbox" :class="{alldone: allDone}">
            <span class="pn">已確認 <b class="num">{{done.length}}</b> / <span class="num">{{rows.length}}</span></span>
            <div class="prog"><i :style="{width:pct+'%'}"></i></div>
            <b class="num pp">{{ allDone ? '✓ 完成' : pct + '%' }}</b>
          </div>
        </div>
      </div>
      <div class="scanrow">
        <div class="scanbox">
          <input ref="scanEl" class="inp" :value="scan" @input="onScanInput" placeholder="刷條碼 / 輸入編號" inputmode="numeric"
            maxlength="13" autocomplete="off" @keydown.enter.prevent="onScan">
          <button class="btn fill" @click="onScan">確認</button>
        </div>
      <div class="scanmsg" :class="msg.kind">
        <div class="ic">{{ {ok:'✓',warn:'!',err:'✕',idle:'⌁'}[msg.kind] }}</div>
        <div style="flex:1"><div class="big">{{msg.title}}</div><div class="small">{{msg.sub}}</div></div>
        <button class="btn orange" v-if="pendingConfirm" @click="forceConfirm">仍要確認第{{pendingConfirm.seq}}次</button>
      </div>
      </div>
    </div>

    <div class="grid2" style="margin-top:16px">
      <div class="card">
        <div class="btns" style="margin-bottom:10px">
          <div class="tabs">
            <button :class="{on:tab==='todo'}" @click="tab='todo'">未確認 <span class="n">{{todo.length}}</span></button>
            <button :class="{on:tab==='done'}" @click="tab='done'">已確認 <span class="n">{{done.length}}</span></button>
            <button :class="{on:tab==='all'}" @click="tab='all'">全部 <span class="n">{{rows.length}}</span></button>
          </div>
          <span style="flex:1"></span>
          <div class="searchbox"><input class="inp" v-model="kw" placeholder="🔍 姓名／電話／醫院／科別／編號" @keydown.esc="kw=''">
            <button class="x" v-if="kw" @click="kw=''">清除</button></div>
          <select class="inp" style="width:auto" v-model="sortKey">
            <option value="order_no">依寄單編號</option><option value="patient_name">依姓名</option>
            <option value="hospital_name">依醫院</option><option value="due_date">依領藥日</option></select>
          <button class="btn sm" @click="printTodo" :disabled="!todo.length">列印未確認清單</button>
        </div>
        <div class="tbl" style="max-height:calc(100vh / var(--z,1) - 200px)"><table>
          <thead><tr><th style="width:40px"></th><th>姓名</th><th>次數</th><th>領藥日</th><th>醫院</th><th>科別</th><th>通知</th><th>寄單編號</th><th>備註</th><th></th></tr></thead>
          <tbody>
            <tr v-for="r in shown" :key="r.fill_id" :class="{flash: flashId===r.fill_id, done: r.fill_status!=='pending'}" @click="toggle(r)">
              <td><span class="chk" :class="{on:r.fill_status!=='pending'}">{{r.fill_status!=='pending' ? '✓' : ''}}</span></td>
              <td class="nw"><span class="t" style="font-size:16px">{{r.patient_name}}</span><span class="famic" v-if="r.family_no" title="有同行家人">👪</span>
                <span class="bdt" v-if="r.birth_date">{{fullOf(r.birth_date)}}</span></td>
              <td class="nw"><span class="sq" :class="'sq'+r.seq">{{r.seq}}</span> 第{{r.seq}}次<span class="last" v-if="r.max_seq===r.seq" title="這張處方的最後一次">末次</span></td>
              <td class="nw num small">{{rocOf(r.due_date)}}({{weekOf(r.due_date)}})</td>
              <td class="small ell" style="max-width:150px" :title="r.hospital_name"><b>{{shortHosp(r.hospital_code, r.hospital_name)}}</b></td>
              <td class="small ell" style="max-width:120px" :title="r.dept_name">{{r.dept_name}}</td>
              <td><NotifyPills :list="r.notify_methods" /></td>
              <td class="nw num tiny muted">{{fmtNo(r.order_no)}}</td>
              <td class="small ell" style="max-width:200px" :title="r.note">{{r.note}}</td>
              <td><button class="btn xs" @click.stop="open(r.order_id)">明細</button></td>
            </tr>
            <tr class="empty-row" v-if="!shown.length"><td colspan="10">{{ kw ? '找不到「'+kw+'」' : tab==='todo' && rows.length ? '🎉 全部確認完成' : '沒有資料' }}</td></tr>
          </tbody>
        </table></div>
      </div>
      <div class="card sticky">
        <h3><i class="sl"></i>刷條碼紀錄</h3>
        <ul class="mini">
          <li v-for="(x,i) in recent" :key="i" :class="{warn:x.kind!=='ok'}" style="cursor:default">
            <span class="t">{{x.kind==='ok'?'✓':x.kind==='warn'?'!':'✕'}} {{x.text}}</span>
            <span class="tiny muted">{{timeOf(x.t)}}</span></li>
          <li v-if="!recent.length" style="cursor:default"><span class="muted small">刷條碼後會顯示在這裡</span></li>
        </ul>
      </div>
    </div>
  
    <div class="mask alarm-mask" v-if="alarm">
      <div class="modal alarm" :class="alarm.kind" role="alertdialog">
        <div class="al-ic">{{ alarm.icon || (alarm.kind === 'err' ? '✕' : '!') }}</div>
        <div class="al-title">{{alarm.title}}</div>
        <div class="al-sub">{{alarm.sub}}</div>
        <div class="al-hint" v-if="alarm.hint">{{alarm.hint}}</div>
        <div class="al-ign" v-if="ignored">警示期間刷了 {{ignored}} 次條碼，都<b>沒有處理</b>，解除後請重刷</div>
        <div class="al-btns">
          <button class="btn lg" v-if="alarm.fill" @click="dismissAlarm">略過，不確認</button>
          <button class="btn lg orange" v-if="alarm.fill" @click="alarmForce">仍要確認第{{alarm.fill.seq}}次</button>
          <button class="btn lg fill" v-else @click="dismissAlarm">我知道了，繼續預作</button>
        </div>
        <div class="al-note">請用滑鼠點按鈕解除；警示期間鍵盤和掃描槍的輸入都不會處理</div>
      </div>
    </div>
  </div>`,
};
