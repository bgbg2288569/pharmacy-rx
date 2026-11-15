// 寄單輸入
import { ref, computed, watch, onMounted } from 'vue';
import { sb, state, q, toastErr, todayISO, addDays, rocOf, dtOf, timeOf, fmtNo, storeSetting, shortHosp } from '../lib.js';
import { OrderForm, FillChip } from '../components.js';
import { printOrder } from '../print.js';

export default {
  components: { OrderForm, FillChip },
  setup() {
    const today = ref([]);
    const form = ref(null);
    const last = computed({ get: () => state.lastSaved, set: v => { state.lastSaved = v; } });   // 剛存好的寄單，可接著寄同行家人
    async function loadToday() {
      if (!state.storeId) return;
      const t = new Date(); t.setHours(0, 0, 0, 0);
      try {
        today.value = await q(sb.from('rx_orders').select('*, fills:rx_fills(*)').eq('store_id', state.storeId)
          .gte('created_at', t.toISOString()).order('created_at', { ascending: false }).limit(200));
      } catch (e) { toastErr(e); }
    }
    watch(() => [state.storeId, state.tick], loadToday);
    onMounted(loadToday);
    const go = r => { location.hash = '#/' + r; };
    const prepDate = () => addDays(todayISO(), Number(storeSetting('prep_days_ahead', 7)));
    const reprint = o => printOrder(o, o.fills);
    const open = id => { state.detailId = id; };
    const onSaved = r => { last.value = r; };
    function addFamily() { form.value?.startFamily(last.value); last.value = null; }
    function addSame() { form.value?.startSamePerson(last.value); last.value = null; }
    return { state, today, form, last, go, prepDate, rocOf, dtOf, timeOf, fmtNo, shortHosp, reprint, open, onSaved, addFamily, addSame };
  },
  template: `<div class="wrap">
    <div class="page-head"><h2><i class="sl"></i>寄單輸入</h2>
      <span class="small muted">Enter 跳下一欄 · 日期輸入 1120 或 1151120 · F1 儲存並列印 · F2 儲存 · F3 清除</span>
      <span class="sp"></span>
      <span class="pill" :class="state.bridge==='ok' ? 'ok' : 'err'" v-if="state.bridge!=='off'"
        :title="state.bridge==='ok' ? '已連線本機藥局系統' : '無法連線本機藥局系統（RxBridge 未啟動？）'">
        藥局系統 {{state.bridge==='ok' ? '已連線' : '未連線'}}</span>
    </div>
    <div class="grid2">
      <div>
        <div class="alert ok" v-if="last" style="margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span>✓ 已寄單 <b class="num">{{fmtNo(last.order_no)}}</b> {{last.payload.patient_name}}</span>
          <span style="flex:1"></span>
          <button class="btn sm teal" @click="addSame">🩺 ＋同一人其他科別</button>
          <button class="btn sm teal" @click="addFamily">👪 ＋寄同行家人（同一通知）</button>
          <button class="x" @click="last=null">✕</button>
        </div>
        <div class="card"><OrderForm ref="form" @saved="onSaved" @open-order="open" /></div>
      </div>
      <div class="sticky">
        <div class="kpis" style="margin-bottom:14px">
          <div class="kpi main" @click="go('search')"><span>今日寄單</span><b>{{today.length}}</b></div>
          <div class="kpi warn" @click="go('prep')"><span>{{rocOf(prepDate())}} 待預作</span><b>{{state.counts.prep_pending ?? '–'}}</b></div>
          <div class="kpi" @click="go('notify')"><span>待通知</span><b>{{state.counts.to_notify ?? '–'}}</b></div>
          <div class="kpi bad" @click="go('prep')"><span>過期未預作</span><b>{{state.counts.late_pending ?? '–'}}</b></div>
        </div>
        <div class="card">
          <h3><i class="sl"></i>今日已寄單</h3>
          <ul class="mini">
            <li v-for="o in today" :key="o.id" @click="open(o.id)" :class="{warn:o.status==='cancelled'}">
              <span class="t ell">{{o.patient_name}}<span class="famic" v-if="o.family_no">👪</span> <span class="tiny muted">{{shortHosp(o.hospital_code, o.hospital_name)}} {{o.dept_name}}</span></span>
              <button class="btn xs" @click.stop="reprint(o)" title="補印">🖨</button>
              <span style="display:flex;gap:4px;flex-wrap:wrap">
                <FillChip v-for="f in o.fills.slice().sort((a,b)=>a.seq-b.seq)" :key="f.id" :f="f" /></span>
              <span class="tiny muted">{{timeOf(o.created_at)}} {{o.created_staff_name}}</span>
            </li>
            <li v-if="!today.length" style="cursor:default"><span class="muted">今天還沒有寄單</span></li>
          </ul>
        </div>
      </div>
    </div>
  </div>`,
};
