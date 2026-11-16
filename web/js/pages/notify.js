// 通知：預作完成 → 通知病人 → 寄單流程結束（領藥回歸藥局系統）
// 同行家人：排在一起、等全家都預作好再一起通知，訊息合併
import { ref, computed, watch, onMounted } from 'vue';
import {
  sb, state, q, rpc, toast, toastErr, todayISO, addDays, rocOf, weekOf, fmtNo, dtOf, fullOf, diffDays,
  ensureOperator, askStaff, setOperator, storeSetting, fillTpl, copyText, bump, NOTIFY, CIRCLED, shortHosp, selfOnly, FILL_STATUS,
  withBusy,
} from '../lib.js';
import { NotifyPills } from '../components.js';

export default {
  components: { NotifyPills },
  setup() {
    const tab = ref('notify');
    const method = ref('');
    const rows = ref([]);
    const famRows = ref([]);          // 同行家人的所有未完成次數（含寄放中），用來判斷全家是否備妥
    const sel = ref(new Set());
    const busy = ref(false);
    const kw = ref('');

    async function load() {
      if (!state.storeId) return;
      try {
        const base = () => sb.from('rx_fill_view').select('*').eq('store_id', state.storeId).neq('order_status', 'cancelled');
        const [prep, done] = await withBusy(Promise.all([
          q(base().eq('fill_status', 'prepared').order('due_date').limit(1000)),
          q(base().eq('fill_status', 'notified').gte('notified_at', new Date(Date.now() - 7 * 864e5).toISOString()).order('notified_at', { ascending: false }).limit(1000)),
        ]), '載入中…');
        rows.value = [...prep, ...done];
        const fams = [...new Set(rows.value.map(r => r.family_no).filter(Boolean))];
        famRows.value = fams.length
          ? await q(sb.from('rx_fill_view').select('fill_id,order_id,family_no,patient_name,seq,due_date,fill_status,dept_name')
            .in('family_no', fams).in('fill_status', ['pending', 'prepared', 'notified']).limit(1000))
          : [];
        sel.value = new Set();
      } catch (e) { toastErr(e); }
    }
    watch(() => [state.storeId, state.tick], load);
    onMounted(load);

    // 同行家人中，領藥日相近（±10 天）的其他人
    function familyOf(r) {
      if (!r.family_no) return [];
      return famRows.value.filter(x => x.family_no === r.family_no && x.order_id !== r.order_id && Math.abs(diffDays(x.due_date, r.due_date)) <= 10);
    }
    const famReady = r => familyOf(r).every(x => x.fill_status !== 'pending');
    const t = todayISO();
    const lists = computed(() => ({
      // 待通知：只列領藥日已到（今天或更早）的；預作好但領藥日未到的，到當天才出現
      notify: rows.value.filter(r => r.fill_status === 'prepared' && !selfOnly(r.notify_methods) && r.due_date <= t),
      later: rows.value.filter(r => r.fill_status === 'prepared' && !selfOnly(r.notify_methods) && r.due_date > t),
      self: rows.value.filter(r => r.fill_status === 'prepared' && selfOnly(r.notify_methods)),
      done: rows.value.filter(r => r.fill_status === 'notified').sort((a, b) => (a.notified_at < b.notified_at ? 1 : -1)),
    }));
    const shown = computed(() => {
      const w = kw.value.trim();
      const list = (lists.value[tab.value] || [])
        .filter(r => !method.value || (r.notify_methods || []).includes(method.value))
        .filter(r => !w || [r.patient_name, r.phone, r.order_no, r.hospital_name, r.dept_name].some(v => String(v || '').includes(w)));
      if (tab.value === 'done') return list;
      // 同行家人排在一起（以群組中最早的領藥日排序）
      const key = r => r.family_no ? (list.filter(x => x.family_no === r.family_no).map(x => x.due_date).sort()[0] + r.family_no) : r.due_date + r.order_no;
      return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.order_no < b.order_no ? -1 : 1));
    });
    const allSel = computed(() => shown.value.length > 0 && shown.value.every(r => sel.value.has(r.fill_id)));
    function toggleAll() { const s = new Set(sel.value); if (allSel.value) shown.value.forEach(r => s.delete(r.fill_id)); else shown.value.forEach(r => s.add(r.fill_id)); sel.value = s; }
    function toggleOne(r) { const s = new Set(sel.value); s.has(r.fill_id) ? s.delete(r.fill_id) : s.add(r.fill_id); sel.value = s; }

    const viaOf = r => (method.value && method.value !== '自取' ? method.value : (r.notify_methods || []).find(m => m !== '自取') || '自取');
    function msgOf(r) {
      const mates = lists.value.notify.filter(x => r.family_no && x.family_no === r.family_no && x.order_id !== r.order_id);
      const names = [r.patient_name, ...mates.map(x => x.patient_name)].join('、');
      const due = [r.due_date, ...mates.map(x => x.due_date)].sort().pop();
      return fillTpl(storeSetting('notify_template', ''), { ...r, patient_name: names }, { seq: r.seq, due_date: due });
    }

    async function act(list, action) {
      const op = await ensureOperator(); if (!op || !list.length) return;
      busy.value = true;
      let ok = 0;
      for (const r of list) {
        try { await rpc('rx_fill_action', { p_fill_id: r.fill_id, p_action: action, p_staff: op.code, p_extra: action === 'notify' ? { via: viaOf(r) } : {} }); ok++; }
        catch (e) { toast(`${r.patient_name}：${e.message}`, 'err', 4000); }
      }
      busy.value = false;
      toast(`${action === 'notify' ? '已通知' : '已撤銷'} ${ok} 筆`, 'ok');
      bump();
    }
    function notifyRow(r) {
      const mates = lists.value.notify.filter(x => r.family_no && x.family_no === r.family_no && x.order_id !== r.order_id);
      if (mates.length && confirm(`同行家人 ${mates.map(x => x.patient_name).join('、')} 也一起標記已通知？`)) return act([r, ...mates], 'notify');
      return act([r], 'notify');
    }
    const batch = action => act(shown.value.filter(r => sel.value.has(r.fill_id)), action);
    async function switchOp() { const s = await askStaff('切換操作人員'); if (s) setOperator(s); }
    const open = id => { state.detailId = id; };
    const today = t;
    return { today, state, tab, method, kw, rows, lists, shown, sel, allSel, busy, toggleAll, toggleOne, act, notifyRow, batch, switchOp, msgOf, copyText,
      open, familyOf, famReady, NOTIFY, CIRCLED, FILL_STATUS, rocOf, weekOf, fmtNo, dtOf, fullOf, shortHosp };
  },
  template: `<div class="wrap wide">
    <div class="page-head"><h2><i class="sl"></i>預作通知</h2>
      <span class="small muted">預作完成後通知病人，寄單流程到「已通知」結束，領藥回歸藥局系統（LINE／簡訊自動發送將於後續串接）</span>
      <span class="sp"></span>
      <span class="small">操作人員：<b>{{state.operator ? state.operator.name : '未設定'}}</b></span>
      <button class="btn sm" @click="switchOp">{{state.operator ? '切換' : '設定'}}</button>
    </div>
    <div class="card">
      <div class="btns" style="margin-bottom:10px">
        <div class="tabs">
          <button :class="{on:tab==='notify'}" @click="tab='notify'; sel=new Set()">待通知 <span class="n">{{lists.notify.length}}</span></button>
          <button :class="{on:tab==='self'}" @click="tab='self'; sel=new Set()">自取已備妥 <span class="n">{{lists.self.length}}</span></button>
          <button :class="{on:tab==='done'}" @click="tab='done'; sel=new Set()">近 7 天已通知 <span class="n">{{lists.done.length}}</span></button>
        </div>
        <div class="chips" style="margin-left:8px" v-if="tab!=='self'">
          <button class="chip" :class="{on:!method}" @click="method=''">全部</button>
          <button class="chip" v-for="m in NOTIFY.filter(m=>m!=='自取')" :key="m" :class="{on:method===m}" @click="method=m">{{m}}</button>
        </div>
        <span style="flex:1"></span>
        <div class="searchbox"><input class="inp" v-model="kw" placeholder="🔍 姓名／電話／醫院／科別"></div>
        <span class="small muted" v-if="sel.size">已選 {{sel.size}} 筆</span>
        <button class="btn sm fill" v-if="tab==='notify'" :disabled="!sel.size || busy" @click="batch('notify')">批次標記已通知</button>
        <button class="btn sm" v-if="tab==='done'" :disabled="!sel.size || busy" @click="batch('unnotify')">批次撤銷通知</button>
      </div>
      <p class="small muted" v-if="tab==='notify'" style="margin:0 0 8px">列出領藥日為今天（{{rocOf(today)}}）及之前、已預作完成的處方。
        <template v-if="lists.later.length">另有 <b>{{lists.later.length}}</b> 筆已預作、領藥日還沒到，到領藥日當天才會出現在這裡。</template></p>
      <p class="small muted" v-if="tab==='self'" style="margin:0 0 8px">只選「自取」的寄單不需通知，預作完成即結束；這裡列出已備妥的，方便客人來詢問時查找。</p>
      <div class="tbl fixed" style="max-height:calc(100vh / var(--z,1) - 230px)"><table>
        <thead><tr>
          <th style="width:36px" v-if="tab!=='self'"><input type="checkbox" :checked="allSel" @change="toggleAll"></th>
          <th>姓名</th><th>電話</th><th>通知方式</th><th>次數</th><th>領藥日</th><th>醫院／科別</th><th>同行家人</th><th>備註</th>
          <th>{{ tab==='done' ? '通知' : '預作' }}</th><th></th>
        </tr></thead>
        <tbody>
          <tr v-for="r in shown" :key="r.fill_id" :class="{sel: sel.has(r.fill_id)}" @click="tab!=='self' && toggleOne(r)">
            <td v-if="tab!=='self'"><input type="checkbox" :checked="sel.has(r.fill_id)" @click.stop="toggleOne(r)"></td>
            <td><span class="t" style="font-size:16px">{{r.patient_name}}</span><span class="famic" v-if="r.family_no" title="有同行家人">👪</span>
              <span class="bdt" v-if="r.birth_date">{{fullOf(r.birth_date)}}</span></td>
            <td class="num small">{{r.phone}}</td>
            <td><NotifyPills :list="r.notify_methods" /></td>
            <td class="nw"><span class="sq" :class="'sq'+r.seq">{{r.seq}}</span> 第{{r.seq}}次<span class="last" v-if="r.max_seq===r.seq">末次</span></td>
            <td class="small"><span class="num">{{rocOf(r.due_date)}}</span>({{weekOf(r.due_date)}})</td>
            <td class="small" style="--mw:220px" :title="r.hospital_name"><b>{{shortHosp(r.hospital_code, r.hospital_name)}}</b> {{r.dept_name}}</td>
            <td class="small" style="--mw:200px">
              <template v-if="r.family_no">
                <span v-for="x in familyOf(r)" :key="x.fill_id" style="margin-right:8px">{{x.patient_name}}
                  <span class="pill" :class="x.fill_status">{{FILL_STATUS[x.fill_status]}}</span></span>
                <b v-if="tab==='notify' && !famReady(r)" style="color:var(--orange-ink)">等家人預作</b>
              </template></td>
            <td class="small" style="--mw:160px" :title="r.note">{{r.note}}</td>
            <td class="small">
              <template v-if="tab==='done'">{{dtOf(r.notified_at)}} {{r.notified_by}} {{r.notified_via}}</template>
              <template v-else>{{dtOf(r.prepared_at)}} {{r.prepared_by}}</template></td>
            <td @click.stop style="text-align:right">
              <template v-if="tab==='notify'">
                <button class="btn xs" title="複製通知訊息（貼到 LINE）" @click="copyText(msgOf(r))">複製訊息</button>
                <button class="btn xs fill" :disabled="busy" @click="notifyRow(r)">已通知</button>
              </template>
              <button class="btn xs" v-if="tab==='done'" :disabled="busy" @click="act([r],'unnotify')">撤銷</button>
              <button class="btn xs ghost" @click="open(r.order_id)">明細</button>
            </td>
          </tr>
          <tr class="empty-row" v-if="!shown.length"><td colspan="11">沒有資料</td></tr>
        </tbody>
      </table></div>
    </div>
  </div>`,
};
