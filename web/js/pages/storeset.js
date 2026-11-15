// 門市設定（門市帳號可自行維護）：單欄排列，上方可快速跳到各區塊
// 寄單預設值｜常用醫院與常用科別｜常用片語｜取消原因｜通知訊息範本｜作業參數｜本機列印｜藥局系統連線
import { ref, reactive, computed, watch, onMounted, nextTick } from 'vue';
import { sb, state, q, rpc, toast, toastErr, loadStoreData, loadCommon, curStore, storeSetting, todayISO, addDays, DEFAULT_CANCEL_REASONS, shortHosp, useDirty } from '../lib.js';
import { HospitalInput, DeptInput, NotifyPicker, TplInput, RocDate, SortableChips, PhraseEditor, UnsavedBar, loadPhraseList, savePhraseList } from '../components.js';
import { PRINT_MODES, getPrintMode, setPrintMode, printOrder } from '../print.js';

const SECTIONS = [
  ['sec-default', '寄單預設值'], ['sec-quick', '常用醫院／科別'], ['sec-phrase', '常用片語'], ['sec-cancel', '取消原因'],
  ['sec-tpl', '通知訊息'], ['sec-param', '作業參數'], ['sec-print', '本機列印'], ['sec-bridge', '藥局系統連線'],
];

export default {
  components: { HospitalInput, DeptInput, NotifyPicker, TplInput, RocDate, SortableChips, PhraseEditor, UnsavedBar },
  setup() {
    // 整頁的設定都先只改畫面，最後按「儲存全部」一次寫入；有未儲存變更時下方會出現提示列，離開本頁前也會提醒
    // （「本機列印」是存在這台電腦的瀏覽器，選了就生效，不在此列）
    const printMode = ref(getPrintMode());
    watch(printMode, m => { setPrintMode(m); toast('本機列印格式已更新', 'ok', 1200); });
    const s = reactive({
      notify_template: '', receipt_footer: '', prep_days_ahead: 7, bridge_url: '', bridge_print: true,
      default_notify: [], default_hospital_code: '', default_hospital_name: '', default_dept_code: '', default_dept_name: '',
      quick_depts: [], cancel_reasons: [], last_prep_date: '',
    });
    const quick = ref([]);
    const phr = ref([]);
    const phrOrig = ref([]);
    const quickOrig = ref([]);
    const orig = ref('');
    const addDept = reactive({ code: '', name: '' });
    const newReason = ref('');
    const bridgeTest = ref('');
    const busy = ref(false);
    const SKEYS = ['notify_template', 'receipt_footer', 'prep_days_ahead', 'bridge_url', 'bridge_print', 'default_notify', 'default_hospital_code',
      'default_hospital_name', 'default_dept_code', 'quick_depts', 'cancel_reasons', 'last_prep_date'];

    const quickKey = l => l.map(x => [x.quick_code, x.hospital_code, x.label || '', x.default_dept || '']);
    const snapshot = () => JSON.stringify({
      s: SKEYS.map(k => (k === 'prep_days_ahead' ? Number(s[k]) || 0 : s[k])),
      q: quickKey(quick.value),
      p: phr.value.map(r => [r.id, r.text]),
    });
    const dirtyParts = computed(() => {
      if (!orig.value) return [];
      const a = JSON.parse(snapshot()), b = JSON.parse(orig.value), out = [];
      if (JSON.stringify(a.s) !== JSON.stringify(b.s)) out.push('門市設定');
      if (JSON.stringify(a.q) !== JSON.stringify(b.q)) out.push('常用醫院');
      if (JSON.stringify(a.p) !== JSON.stringify(b.p)) out.push('常用片語');
      return out;
    });
    const dirty = computed(() => dirtyParts.value.length > 0);
    useDirty('storeset', dirty);

    async function loadForm() {
      const st = curStore()?.settings || {};
      Object.assign(s, {
        notify_template: st.notify_template || '', receipt_footer: st.receipt_footer || '',
        prep_days_ahead: st.prep_days_ahead ?? storeSetting('prep_days_ahead', 7), bridge_url: st.bridge_url || '', bridge_print: st.bridge_print !== false,
        default_notify: [...(st.default_notify || [])], default_hospital_code: st.default_hospital_code || '',
        default_hospital_name: st.default_hospital_name || '', default_dept_code: st.default_dept_code || '', default_dept_name: '',
        quick_depts: [...(st.quick_depts || [])], cancel_reasons: [...(st.cancel_reasons || DEFAULT_CANCEL_REASONS)],
        last_prep_date: st.last_prep_date || '',
      });
      quick.value = state.quick.map(x => ({ ...x, _old: x.quick_code, dept_name: '' }));
      quickOrig.value = state.quick.map(x => ({ ...x }));
      try { phrOrig.value = await loadPhraseList(state.storeId); } catch (e) { toastErr(e); phrOrig.value = []; }
      phr.value = phrOrig.value.map(r => ({ ...r }));
      await nextTick();
      orig.value = snapshot();
    }
    watch(() => state.storeId, loadForm);
    onMounted(loadForm);

    // ---- 儲存全部 ----
    function checkQuick() {
      const seen = new Set();
      for (const [i, x] of quick.value.entries()) {
        x.quick_code = String(x.quick_code || '').trim().toUpperCase();
        if (!/^[0-9A-Z]{1,2}$/.test(x.quick_code)) return `常用醫院第 ${i + 1} 列：快速碼需為 1～2 碼英數字`;
        if (!x.hospital_code) return `常用醫院第 ${i + 1} 列（${x.quick_code}）：請從清單選擇醫院`;
        if (seen.has(x.quick_code)) return `常用醫院快速碼 ${x.quick_code} 重複`;
        seen.add(x.quick_code);
      }
      return '';
    }
    async function saveAll() {
      const err = checkQuick();
      if (err) { toast(err, 'err'); jump('sec-quick'); return; }
      busy.value = true;
      try {
        const parts = dirtyParts.value;
        if (parts.includes('門市設定')) {
          const payload = {};
          for (const k of SKEYS) payload[k] = typeof s[k] === 'string' ? s[k].trim() : s[k];
          payload.prep_days_ahead = Number(payload.prep_days_ahead) || 7;
          await rpc('rx_update_store_settings', { p_store: state.storeId, p_settings: payload });
        }
        if (parts.includes('常用醫院')) {
          const keep = new Set(quick.value.map(x => x.quick_code));
          const gone = quickOrig.value.map(x => x.quick_code).filter(c => !keep.has(c));
          if (gone.length) await q(sb.from('rx_hospital_quick').delete().eq('store_id', state.storeId).in('quick_code', gone));
          if (quick.value.length) {
            await q(sb.from('rx_hospital_quick').upsert(quick.value.map((x, i) => ({
              store_id: state.storeId, quick_code: x.quick_code, hospital_code: x.hospital_code,
              label: x.label || null, default_dept: x.default_dept || null, sort: i + 1,
            })), { onConflict: 'store_id,quick_code' }));
          }
        }
        if (parts.includes('常用片語')) await savePhraseList(state.storeId, phrOrig.value, phr.value);
        await loadCommon(); await loadStoreData();
        await loadForm();
        toast('門市設定已全部儲存', 'ok', 1600);
      } catch (e) { toastErr(e); } finally { busy.value = false; }
    }
    function discard() { if (confirm('放棄所有未儲存的變更，回到上次儲存的設定？')) loadForm(); }

    // ---- 常用科別 ----
    const deptName = c => state.depts.find(d => d.code === c)?.name || c;
    watch(() => addDept.code, c => {
      if (!c) return;
      if (!s.quick_depts.includes(c)) s.quick_depts.push(c);
      else toast('已經在常用科別裡', 'warn', 1200);
      setTimeout(() => { addDept.code = ''; addDept.name = ''; }, 0);
    });
    const reorderDepts = list => { s.quick_depts = list; };
    const removeDept = c => { s.quick_depts = s.quick_depts.filter(x => x !== c); };

    // ---- 取消原因 ----
    function addReason() {
      const t = newReason.value.trim();
      if (!t) return;
      if (s.cancel_reasons.includes(t)) { toast('已經有這個原因', 'warn'); return; }
      s.cancel_reasons.push(t); newReason.value = '';
    }
    const reorderReasons = list => { s.cancel_reasons = list; };
    const removeReason = t => { s.cancel_reasons = s.cancel_reasons.filter(x => x !== t); };

    // ---- 常用醫院：表格編輯＋拖拉列排序 ----
    function addQuick() {
      const used = new Set(quick.value.map(x => x.quick_code));
      let n = 1; while (used.has(String(n).padStart(2, '0'))) n++;
      quick.value.push({ store_id: state.storeId, quick_code: String(n).padStart(2, '0'), hospital_code: '', name: '', label: '', default_dept: '', dept_name: '', _old: null });
    }
    const delQuick = x => { quick.value = quick.value.filter(y => y !== x); };
    const quickChanged = x => {
      const o = quickOrig.value.find(y => y.quick_code === x._old);
      return !o || JSON.stringify(quickKey([x])) !== JSON.stringify(quickKey([o]));
    };
    const dragFrom = ref(-1);
    const dragOver = ref(-1);
    function dropQuick(i) {
      const f = dragFrom.value; dragFrom.value = -1; dragOver.value = -1;
      if (f < 0 || f === i) return;
      const a = [...quick.value]; const [x] = a.splice(f, 1); a.splice(i, 0, x); quick.value = a;
    }

    // ---- 列印、藥局系統連線 ----
    async function testBridge() {
      const u = (s.bridge_url || '').trim().replace(/\/+$/, '');
      if (!u) { bridgeTest.value = '請先輸入連線網址'; return; }
      bridgeTest.value = '測試中…';
      try {
        const r = await fetch(u + '/health', { signal: AbortSignal.timeout(2500) });
        if (!r.ok) throw new Error(r.status);
        const rows = await (await fetch(`${u}/patients?q=${encodeURIComponent('王')}`, { signal: AbortSignal.timeout(2500) })).json();
        bridgeTest.value = `✓ 已連線，測試查詢「王」取得 ${Array.isArray(rows) ? rows.length : 0} 筆` + (dirty.value ? '（記得按「儲存全部」）' : '');
      } catch { bridgeTest.value = `✕ 無法連線 ${u}，請確認 RxBridge 已在這台電腦執行`; }
    }
    function testPrint() {
      printOrder({ order_no: '26111300013', patient_name: '測試病人', phone: '0912345678', notify_methods: ['LINE'],
        hospital_code: state.quick[0]?.hospital_code, hospital_name: state.quick[0]?.name || '台北市立聯合醫院', dept_name: '心臟血管內科',
        note: '列印測試', created_at: new Date().toISOString(), created_staff_name: '測試' },
      [{ seq: 2, due_date: addDays(todayISO(), 7), status: 'pending' }, { seq: 3, due_date: addDays(todayISO(), 35), status: 'pending' }], printMode.value);
    }
    const jump = id => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    return { state, s, quick, phr, addDept, newReason, bridgeTest, printMode, PRINT_MODES, SECTIONS, deptName, shortHosp,
      dirty, dirtyParts, busy, saveAll, discard, reorderDepts, removeDept, addReason, reorderReasons, removeReason,
      addQuick, delQuick, quickChanged, dragFrom, dragOver, dropQuick, testBridge, testPrint, jump, curStore };
  },
  template: `<div class="wrap setwrap">
    <div class="page-head"><h2><i class="sl"></i>門市設定</h2><span class="pill store">{{curStore()?.name}}</span>
      <span class="hint">整頁設定完成後按「儲存全部」一次寫入</span><span style="flex:1"></span>
      <button class="btn fill" :disabled="!dirty || busy" @click="saveAll">儲存全部</button></div>
    <nav class="setnav"><button v-for="x in SECTIONS" :key="x[0]" @click="jump(x[0])">{{x[1]}}</button></nav>

    <section class="card setcard" id="sec-default">
      <div class="sethead"><h3><i class="sl"></i>寄單預設值</h3><span class="hint">新寄單時自動帶入，仍可逐筆修改；選了過往紀錄則以紀錄為主</span>
</div>
      <div class="setrow"><label>預設通知方式</label><div><NotifyPicker v-model="s.default_notify" /></div></div>
      <div class="setrow"><label>預設醫院</label><div style="max-width:520px"><HospitalInput v-model:code="s.default_hospital_code" v-model:name="s.default_hospital_name" /></div></div>
      <div class="setrow"><label>預設科別</label><div style="max-width:320px"><DeptInput v-model:code="s.default_dept_code" v-model:name="s.default_dept_name" /></div></div>
    </section>

    <section class="card setcard" id="sec-quick">
      <div class="sethead"><h3><i class="sl"></i>常用醫院／科別</h3><span class="hint">顯示在寄單畫面的醫院、科別欄下方；拖拉 ⠿ 可調整順序</span></div>
      <div class="setrow top"><label>常用醫院<span class="sub">醫院欄可輸入名稱或院所代號，從建議清單點選；建議 8～10 間</span></label>
        <div>
          <div class="tbl"><table class="rowedit">
            <thead><tr><th style="width:34px"></th><th style="width:70px">快速碼</th><th style="min-width:260px">醫院</th><th style="width:120px">顯示簡稱</th><th style="width:180px">預設科別</th><th style="width:110px"></th></tr></thead>
            <tbody>
              <tr v-for="(x,i) in quick" :key="(x._old||'new')+i" style="cursor:default" :class="{dragging: dragFrom===i, over: dragOver===i && dragFrom!==i, sel: quickChanged(x)}"
                @dragenter.prevent="dragFrom>=0 && (dragOver=i)" @dragover.prevent @drop.prevent="dropQuick(i)">
                <td><span class="grip big" draggable="true" title="拖拉調整順序" @dragstart="dragFrom=i; $event.dataTransfer.effectAllowed='move'" @dragend="dragFrom=-1; dragOver=-1">⠿</span></td>
                <td><input class="inp num" v-model="x.quick_code" maxlength="2"></td>
                <td><HospitalInput v-model:code="x.hospital_code" v-model:name="x.name" /></td>
                <td><input class="inp" v-model="x.label" :placeholder="shortHosp(x.hospital_code, x.name) || '例：台大'"></td>
                <td><DeptInput v-model:code="x.default_dept" v-model:name="x.dept_name" /></td>
                <td class="nw"><span class="tag-new" v-if="!x._old">新增</span> <button class="btn xs danger" @click="delQuick(x)">刪除</button></td>
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
      <div class="sethead"><h3><i class="sl"></i>常用片語</h3><span class="hint">寄單備註下方的標籤；拖拉調整順序</span></div>
      <div class="setrow top"><label>本門市</label><div><PhraseEditor v-model="phr" /></div></div>
      <div class="setrow top"><label>全門市共用<span class="sub">由管理員維護</span></label>
        <div class="chips"><span class="chip static" v-for="p in state.phrases.filter(p=>!p.store_id)" :key="p.id">{{p.text}}</span></div></div>
    </section>

    <section class="card setcard" id="sec-cancel">
      <div class="sethead"><h3><i class="sl"></i>取消原因</h3><span class="hint">取消寄單／取消某次時可點選；拖拉調整順序</span></div>
      <div class="setrow top"><label>原因選項</label>
        <div>
          <SortableChips :items="s.cancel_reasons" @reorder="reorderReasons" @remove="removeReason" />
          <div class="inline addrow"><input class="inp" v-model="newReason" placeholder="輸入新原因後按 Enter" @keydown.enter.prevent="addReason"><button class="btn sm" @click="addReason">＋ 新增</button></div>
        </div>
      </div>
    </section>

    <section class="card setcard" id="sec-tpl">
      <div class="sethead"><h3><i class="sl"></i>通知訊息</h3></div>
      <div class="setrow top"><label>通知訊息範本<span class="sub">空白則用系統預設；同行家人姓名會自動合併</span></label>
        <div><TplInput v-model="s.notify_template" :placeholder="state.settings.notify_template" /></div></div>
      <div class="setrow"><label>發票機單據底部文字</label><div><input class="inp" v-model="s.receipt_footer" :placeholder="state.settings.receipt_footer"></div></div>
    </section>

    <section class="card setcard" id="sec-param">
      <div class="sethead"><h3><i class="sl"></i>作業參數</h3></div>
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
      <div class="setrow"><label>連線網址</label><div class="inline" style="max-width:520px"><input class="inp" v-model="s.bridge_url" placeholder="http://localhost:5880"><button class="btn" @click="testBridge">測試連線</button></div></div>
      <div class="setrow"><label></label><div class="hint">{{bridgeTest || '福原藥局：在櫃台電腦執行 RxBridge 後填 http://localhost:5880，輸入姓名時即可查詢藥局系統病人資料。'}}</div></div>
      <div class="setrow"><label>貼紙列印</label><div><label class="ck"><input type="checkbox" v-model="s.bridge_print"> 4×3 貼紙交給 RxBridge 直接列印（不跳列印視窗）</label>
        <div class="hint">印表機在 RxBridge.ini 的 LabelPrinter 設定；RxBridge 沒開時會自動改用瀏覽器列印。</div></div></div>
    </section>
    <UnsavedBar :dirty="dirty" :busy="busy" :count="dirtyParts.length" @save="saveAll" @discard="discard" />
  </div>`,
};
