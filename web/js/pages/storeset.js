// 門市設定（門市帳號可自行維護）：單欄排列，上方可快速跳到各區塊
// 寄單預設值｜常用醫院與常用科別｜常用片語｜取消原因｜通知訊息範本｜作業參數｜本機列印｜藥局系統連線
import { ref, reactive, watch, onMounted } from 'vue';
import { sb, state, q, rpc, toast, toastErr, loadStoreData, loadCommon, curStore, storeSetting, pingBridge, bridgeUrl, bridgeSearch, todayISO, addDays, DEFAULT_CANCEL_REASONS, shortHosp } from '../lib.js';
import { HospitalInput, DeptInput, NotifyPicker, TplInput, RocDate, SortableChips, PhraseEditor } from '../components.js';
import { PRINT_MODES, getPrintMode, setPrintMode, printOrder } from '../print.js';

const SECTIONS = [
  ['sec-default', '寄單預設值'], ['sec-quick', '常用醫院／科別'], ['sec-phrase', '常用片語'], ['sec-cancel', '取消原因'],
  ['sec-tpl', '通知訊息'], ['sec-param', '作業參數'], ['sec-print', '本機列印'], ['sec-bridge', '藥局系統連線'],
];

export default {
  components: { HospitalInput, DeptInput, NotifyPicker, TplInput, RocDate, SortableChips, PhraseEditor },
  setup() {
    const quick = ref([]);
    const printMode = ref(getPrintMode());
    watch(printMode, m => { setPrintMode(m); toast('本機列印格式已更新', 'ok', 1200); });
    const s = reactive({
      notify_template: '', receipt_footer: '', prep_days_ahead: 7, bridge_url: '',
      default_notify: [], default_hospital_code: '', default_hospital_name: '', default_dept_code: '', default_dept_name: '',
      quick_depts: [], cancel_reasons: [], last_prep_date: '',
    });
    const addDept = reactive({ code: '', name: '' });
    const newReason = ref('');
    const bridgeTest = ref('');

    function loadForm() {
      const st = curStore()?.settings || {};
      Object.assign(s, {
        notify_template: st.notify_template || '', receipt_footer: st.receipt_footer || '',
        prep_days_ahead: st.prep_days_ahead ?? storeSetting('prep_days_ahead', 7), bridge_url: st.bridge_url || '',
        default_notify: [...(st.default_notify || [])], default_hospital_code: st.default_hospital_code || '',
        default_hospital_name: st.default_hospital_name || '', default_dept_code: st.default_dept_code || '', default_dept_name: '',
        quick_depts: [...(st.quick_depts || [])], cancel_reasons: [...(st.cancel_reasons || DEFAULT_CANCEL_REASONS)],
        last_prep_date: st.last_prep_date || '',
      });
      quick.value = state.quick.map(x => ({ ...x, _old: x.quick_code, dept_name: '' }));
    }
    watch(() => [state.storeId, state.quick, state.stores], loadForm);
    onMounted(loadForm);

    // ---- 儲存門市設定（傳入要存的欄位） ----
    async function saveKeys(keys, msg = '已儲存') {
      const payload = {};
      for (const k of keys) payload[k] = typeof s[k] === 'string' ? s[k].trim() : s[k];
      if ('prep_days_ahead' in payload) payload.prep_days_ahead = Number(payload.prep_days_ahead) || 7;
      try {
        await rpc('rx_update_store_settings', { p_store: state.storeId, p_settings: payload });
        await loadCommon(); toast(msg, 'ok', 1400);
      } catch (e) { toastErr(e); }
    }
    const saveDefaults = () => saveKeys(['default_notify', 'default_hospital_code', 'default_hospital_name', 'default_dept_code'], '寄單預設值已儲存');
    const saveTpl = () => saveKeys(['notify_template', 'receipt_footer'], '通知訊息已儲存');
    const saveParam = () => saveKeys(['prep_days_ahead', 'last_prep_date'], '作業參數已儲存');

    // ---- 常用科別：拖拉排序、即時儲存 ----
    const deptName = c => state.depts.find(d => d.code === c)?.name || c;
    watch(() => addDept.code, c => {
      if (!c) return;
      if (!s.quick_depts.includes(c)) { s.quick_depts.push(c); saveKeys(['quick_depts'], `已加入常用科別：${deptName(c)}`); }
      setTimeout(() => { addDept.code = ''; addDept.name = ''; }, 0);
    });
    function reorderDepts(list) { s.quick_depts = list; saveKeys(['quick_depts'], '順序已儲存'); }
    function removeDept(c) { s.quick_depts = s.quick_depts.filter(x => x !== c); saveKeys(['quick_depts'], '已移除'); }

    // ---- 取消原因：拖拉排序、即時儲存 ----
    function addReason() {
      const t = newReason.value.trim();
      if (!t) return;
      if (s.cancel_reasons.includes(t)) { toast('已經有這個原因', 'warn'); return; }
      s.cancel_reasons.push(t); newReason.value = '';
      saveKeys(['cancel_reasons'], '已新增取消原因');
    }
    function reorderReasons(list) { s.cancel_reasons = list; saveKeys(['cancel_reasons'], '順序已儲存'); }
    function removeReason(t) { s.cancel_reasons = s.cancel_reasons.filter(x => x !== t); saveKeys(['cancel_reasons'], '已移除'); }

    // ---- 常用醫院：表格編輯＋拖拉列排序 ----
    function addQuick() {
      const used = new Set(quick.value.map(x => x.quick_code));
      let n = 1; while (used.has(String(n).padStart(2, '0'))) n++;
      quick.value.push({ store_id: state.storeId, quick_code: String(n).padStart(2, '0'), hospital_code: '', name: '', label: '', default_dept: '', sort: quick.value.length + 1, _old: null });
    }
    async function saveQuick(x) {
      if (!/^[0-9A-Za-z]{1,2}$/.test(x.quick_code)) return toast('快速碼為 1～2 碼英數字', 'err');
      if (!x.hospital_code) return toast('請從清單選擇醫院', 'err');
      try {
        if (x._old && x._old !== x.quick_code) await q(sb.from('rx_hospital_quick').delete().eq('store_id', state.storeId).eq('quick_code', x._old));
        await q(sb.from('rx_hospital_quick').upsert({
          store_id: state.storeId, quick_code: x.quick_code.toUpperCase(), hospital_code: x.hospital_code,
          label: x.label || null, default_dept: x.default_dept || null, sort: Number(x.sort) || quick.value.indexOf(x) + 1,
        }, { onConflict: 'store_id,quick_code' }));
        toast('已儲存', 'ok', 1400); await loadStoreData();
      } catch (e) { toastErr(e); }
    }
    async function delQuick(x) {
      if (!x._old) { quick.value = quick.value.filter(y => y !== x); return; }
      if (!confirm(`刪除快速碼 ${x.quick_code}？`)) return;
      try { await q(sb.from('rx_hospital_quick').delete().eq('store_id', state.storeId).eq('quick_code', x._old)); await loadStoreData(); }
      catch (e) { toastErr(e); }
    }
    const dragFrom = ref(-1);
    const dragOver = ref(-1);
    async function dropQuick(i) {
      const f = dragFrom.value; dragFrom.value = -1; dragOver.value = -1;
      if (f < 0 || f === i) return;
      const a = [...quick.value]; const [x] = a.splice(f, 1); a.splice(i, 0, x); quick.value = a;
      const saved = a.filter(r => r._old);
      try {
        await Promise.all(saved.map((r, k) => q(sb.from('rx_hospital_quick').update({ sort: k + 1 }).eq('store_id', state.storeId).eq('quick_code', r._old))));
        toast('順序已儲存', 'ok', 1200); await loadStoreData();
      } catch (e) { toastErr(e); }
    }

    // ---- 列印、藥局系統連線 ----
    async function testBridge() {
      bridgeTest.value = '測試中…';
      await saveKeys(['bridge_url'], '連線網址已儲存');
      await pingBridge();
      if (state.bridge !== 'ok') { bridgeTest.value = `✕ 無法連線 ${bridgeUrl() || '(未設定)'}，請確認 RxBridge 已在這台電腦執行`; return; }
      const rows = await bridgeSearch('王');
      bridgeTest.value = `✓ 已連線，測試查詢「王」取得 ${rows.length} 筆`;
    }
    function testPrint() {
      printOrder({ order_no: '26111300013', patient_name: '測試病人', phone: '0912345678', notify_methods: ['LINE'],
        hospital_code: state.quick[0]?.hospital_code, hospital_name: state.quick[0]?.name || '台北市立聯合醫院', dept_name: '心臟血管內科',
        note: '列印測試', created_at: new Date().toISOString(), created_staff_name: '測試' },
      [{ seq: 2, due_date: addDays(todayISO(), 7), status: 'pending' }, { seq: 3, due_date: addDays(todayISO(), 35), status: 'pending' }], printMode.value);
    }
    const jump = id => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    return { state, s, quick, addDept, newReason, bridgeTest, printMode, PRINT_MODES, SECTIONS, deptName, shortHosp,
      saveKeys, saveDefaults, saveTpl, saveParam, reorderDepts, removeDept, addReason, reorderReasons, removeReason,
      addQuick, saveQuick, delQuick, dragFrom, dragOver, dropQuick, testBridge, testPrint, jump, curStore };
  },
  template: `<div class="wrap setwrap">
    <div class="page-head"><h2><i class="sl"></i>門市設定</h2><span class="pill store">{{curStore()?.name}}</span></div>
    <nav class="setnav"><button v-for="x in SECTIONS" :key="x[0]" @click="jump(x[0])">{{x[1]}}</button></nav>

    <section class="card setcard" id="sec-default">
      <div class="sethead"><h3><i class="sl"></i>寄單預設值</h3><span class="hint">新寄單時自動帶入，仍可逐筆修改；選了過往紀錄則以紀錄為主</span>
        <span style="flex:1"></span><button class="btn fill sm" @click="saveDefaults">儲存</button></div>
      <div class="setrow"><label>預設通知方式</label><div><NotifyPicker v-model="s.default_notify" /></div></div>
      <div class="setrow"><label>預設醫院</label><div style="max-width:520px"><HospitalInput v-model:code="s.default_hospital_code" v-model:name="s.default_hospital_name" /></div></div>
      <div class="setrow"><label>預設科別</label><div style="max-width:320px"><DeptInput v-model:code="s.default_dept_code" v-model:name="s.default_dept_name" /></div></div>
    </section>

    <section class="card setcard" id="sec-quick">
      <div class="sethead"><h3><i class="sl"></i>常用醫院／科別</h3><span class="hint">顯示在寄單畫面的醫院、科別欄下方；拖拉 ⠿ 可調整順序，變更即儲存</span></div>
      <div class="setrow top"><label>常用醫院<span class="sub">輸入快速碼（例：01）＋ Enter 帶入；建議 8～10 間</span></label>
        <div>
          <div class="tbl"><table class="rowedit">
            <thead><tr><th style="width:34px"></th><th style="width:70px">快速碼</th><th style="min-width:260px">醫院</th><th style="width:120px">顯示簡稱</th><th style="width:180px">預設科別</th><th style="width:130px"></th></tr></thead>
            <tbody>
              <tr v-for="(x,i) in quick" :key="(x._old||'new')+i" style="cursor:default" :class="{dragging: dragFrom===i, over: dragOver===i && dragFrom!==i}"
                @dragenter.prevent="dragFrom>=0 && (dragOver=i)" @dragover.prevent @drop.prevent="dropQuick(i)">
                <td><span class="grip big" draggable="true" title="拖拉調整順序" @dragstart="dragFrom=i; $event.dataTransfer.effectAllowed='move'" @dragend="dragFrom=-1; dragOver=-1">⠿</span></td>
                <td><input class="inp num" v-model="x.quick_code" maxlength="2"></td>
                <td><HospitalInput v-model:code="x.hospital_code" v-model:name="x.name" /></td>
                <td><input class="inp" v-model="x.label" :placeholder="shortHosp(x.hospital_code, x.name) || '例：台大'"></td>
                <td><DeptInput v-model:code="x.default_dept" v-model:name="x.dept_name" /></td>
                <td class="nw"><button class="btn xs fill" @click="saveQuick(x)">儲存</button> <button class="btn xs danger" @click="delQuick(x)">刪除</button></td>
              </tr>
              <tr class="empty-row" v-if="!quick.length"><td colspan="6">尚未設定</td></tr>
            </tbody>
          </table></div>
          <button class="btn sm" style="margin-top:8px" @click="addQuick">＋ 新增常用醫院</button>
        </div>
      </div>
      <div class="setrow top"><label>常用科別<span class="sub">建議 6～9 個</span></label>
        <div>
          <SortableChips :items="s.quick_depts" :prefix="c => c" :label="deptName" @reorder="reorderDepts" @remove="removeDept" />
          <div class="addrow" style="max-width:320px"><DeptInput v-model:code="addDept.code" v-model:name="addDept.name" /></div>
        </div>
      </div>
    </section>

    <section class="card setcard" id="sec-phrase">
      <div class="sethead"><h3><i class="sl"></i>常用片語</h3><span class="hint">寄單備註下方的標籤；拖拉調整順序，變更即儲存</span></div>
      <div class="setrow top"><label>本門市</label><div><PhraseEditor :store-id="state.storeId" /></div></div>
      <div class="setrow top"><label>全門市共用<span class="sub">由管理員維護</span></label>
        <div class="chips"><span class="chip static" v-for="p in state.phrases.filter(p=>!p.store_id)" :key="p.id">{{p.text}}</span></div></div>
    </section>

    <section class="card setcard" id="sec-cancel">
      <div class="sethead"><h3><i class="sl"></i>取消原因</h3><span class="hint">取消寄單／取消某次時可點選；拖拉調整順序，變更即儲存</span></div>
      <div class="setrow top"><label>原因選項</label>
        <div>
          <SortableChips :items="s.cancel_reasons" @reorder="reorderReasons" @remove="removeReason" />
          <div class="inline addrow"><input class="inp" v-model="newReason" placeholder="輸入新原因後按 Enter" @keydown.enter.prevent="addReason"><button class="btn sm" @click="addReason">＋ 新增</button></div>
        </div>
      </div>
    </section>

    <section class="card setcard" id="sec-tpl">
      <div class="sethead"><h3><i class="sl"></i>通知訊息</h3><span style="flex:1"></span><button class="btn fill sm" @click="saveTpl">儲存</button></div>
      <div class="setrow top"><label>通知訊息範本<span class="sub">空白則用系統預設；同行家人姓名會自動合併</span></label>
        <div><TplInput v-model="s.notify_template" :placeholder="state.settings.notify_template" /></div></div>
      <div class="setrow"><label>發票機單據底部文字</label><div><input class="inp" v-model="s.receipt_footer" :placeholder="state.settings.receipt_footer"></div></div>
    </section>

    <section class="card setcard" id="sec-param">
      <div class="sethead"><h3><i class="sl"></i>作業參數</h3><span style="flex:1"></span><button class="btn fill sm" @click="saveParam">儲存</button></div>
      <div class="setrow"><label>預作提前天數</label><div class="inline" style="max-width:360px"><input class="inp num" type="number" v-model="s.prep_days_ahead" style="max-width:110px"><span class="hint">預作確認頁預設顯示「今天 + N 天」</span></div></div>
      <div class="setrow"><label>最新預作日</label><div class="inline" style="max-width:640px"><div style="width:200px"><RocDate v-model="s.last_prep_date" compact /></div>
        <span class="hint">預作確認時自動更新；寄單的領藥日早於或等於此日會提醒「直接打單調劑」。有誤可在此修正</span></div></div>
    </section>

    <section class="card setcard" id="sec-print">
      <div class="sethead"><h3><i class="sl"></i>本機列印</h3><span class="hint">每台電腦各自設定（存在這台電腦的瀏覽器），選擇後立即生效</span></div>
      <div class="setrow"><label>列印格式</label><div class="inline" style="max-width:420px"><select class="inp" v-model="printMode"><option v-for="m in PRINT_MODES" :key="m.id" :value="m.id">{{m.name}}</option></select>
        <button class="btn" @click="testPrint">測試列印</button></div></div>
      <div class="setrow"><label>免跳出列印視窗</label><div class="hint">Chrome 捷徑的「目標」最後加上 <code>--kiosk-printing</code>，並把標籤機設為 Windows 預設印表機</div></div>
    </section>

    <section class="card setcard" id="sec-bridge">
      <div class="sethead"><h3><i class="sl"></i>藥局系統連線（RxBridge）</h3><span class="hint">沒有就留空</span></div>
      <div class="setrow"><label>連線網址</label><div class="inline" style="max-width:520px"><input class="inp" v-model="s.bridge_url" placeholder="http://localhost:5880"><button class="btn" @click="testBridge">儲存並測試</button></div></div>
      <div class="setrow"><label></label><div class="hint">{{bridgeTest || '福原藥局：在櫃台電腦執行 RxBridge 後填 http://localhost:5880，輸入姓名時即可查詢藥局系統病人資料。'}}</div></div>
    </section>
  </div>`,
};
