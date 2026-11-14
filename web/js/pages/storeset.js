// 門市設定：寄單預設值、常用醫院快速碼、常用科別、常用片語、列印、通知範本、藥局系統連線（門市帳號可自行維護）
import { ref, reactive, watch, onMounted } from 'vue';
import { sb, state, q, rpc, toast, toastErr, loadStoreData, loadCommon, curStore, storeSetting, pingBridge, bridgeUrl, bridgeSearch, todayISO, addDays, DEFAULT_CANCEL_REASONS } from '../lib.js';
import { HospitalInput, DeptInput, NotifyPicker, CrudTable, TplInput, RocDate } from '../components.js';
import { PRINT_MODES, getPrintMode, setPrintMode, printOrder } from '../print.js';

export default {
  components: { HospitalInput, DeptInput, NotifyPicker, CrudTable, TplInput, RocDate },
  setup() {
    const quick = ref([]);
    const printMode = ref(getPrintMode());
    watch(printMode, setPrintMode);
    const s = reactive({
      notify_template: '', receipt_footer: '', prep_days_ahead: 7, bridge_url: '',
      default_notify: [], default_hospital_code: '', default_hospital_name: '', default_dept_code: '', default_dept_name: '', quick_depts: [],
      cancel_reasons: [], last_prep_date: '',
    });
    const newReason = ref('');
    function addReason() { const t = newReason.value.trim(); if (t && !s.cancel_reasons.includes(t)) s.cancel_reasons.push(t); newReason.value = ''; }
    const delReason = t => { s.cancel_reasons = s.cancel_reasons.filter(x => x !== t); };
    function moveReason(i, d) { const a = s.cancel_reasons, j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; }
    const addDept = reactive({ code: '', name: '' });
    const bridgeTest = ref('');

    function loadForm() {
      const st = curStore()?.settings || {};
      Object.assign(s, {
        notify_template: st.notify_template || '', receipt_footer: st.receipt_footer || '',
        prep_days_ahead: st.prep_days_ahead ?? storeSetting('prep_days_ahead', 7), bridge_url: st.bridge_url || '',
        default_notify: [...(st.default_notify || [])], default_hospital_code: st.default_hospital_code || '',
        default_hospital_name: st.default_hospital_name || '', default_dept_code: st.default_dept_code || '', default_dept_name: '',
        quick_depts: [...(st.quick_depts || [])],
        cancel_reasons: [...(st.cancel_reasons || DEFAULT_CANCEL_REASONS)], last_prep_date: st.last_prep_date || '',
      });
      quick.value = state.quick.map(x => ({ ...x, _old: x.quick_code, dept_name: '' }));
    }
    watch(() => [state.storeId, state.quick, state.stores], loadForm);
    onMounted(loadForm);

    const deptName = c => state.depts.find(d => d.code === c)?.name || c;
    watch(() => addDept.code, c => {
      if (c && !s.quick_depts.includes(c)) s.quick_depts.push(c);
      if (c) setTimeout(() => { addDept.code = ''; addDept.name = ''; }, 0);
    });
    const removeDept = c => { s.quick_depts = s.quick_depts.filter(x => x !== c); };
    function moveDept(i, d) {
      const a = s.quick_depts, j = i + d;
      if (j < 0 || j >= a.length) return;
      [a[i], a[j]] = [a[j], a[i]];
    }

    function addQuick() {
      const used = new Set(quick.value.map(x => x.quick_code));
      let n = 1; while (used.has(String(n).padStart(2, '0'))) n++;
      quick.value.push({ store_id: state.storeId, quick_code: String(n).padStart(2, '0'), hospital_code: '', name: '', label: '', default_dept: '', sort: n, _old: null });
    }
    async function saveQuick(x) {
      if (!/^[0-9A-Za-z]{1,2}$/.test(x.quick_code)) return toast('快速碼為 1～2 碼英數字', 'err');
      if (!x.hospital_code) return toast('請從清單選擇醫院', 'err');
      try {
        if (x._old && x._old !== x.quick_code) await q(sb.from('rx_hospital_quick').delete().eq('store_id', state.storeId).eq('quick_code', x._old));
        await q(sb.from('rx_hospital_quick').upsert({
          store_id: state.storeId, quick_code: x.quick_code.toUpperCase(), hospital_code: x.hospital_code,
          label: x.label || null, default_dept: x.default_dept || null, sort: Number(x.sort) || 0,
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

    async function saveSettings() {
      try {
        await rpc('rx_update_store_settings', { p_store: state.storeId, p_settings: {
          notify_template: s.notify_template, receipt_footer: s.receipt_footer, bridge_url: s.bridge_url.trim(),
          prep_days_ahead: Number(s.prep_days_ahead) || 7,
          default_notify: s.default_notify, default_hospital_code: s.default_hospital_code, default_hospital_name: s.default_hospital_name,
          default_dept_code: s.default_dept_code, quick_depts: s.quick_depts,
          cancel_reasons: s.cancel_reasons, last_prep_date: s.last_prep_date || '',
        } });
        await loadCommon(); toast('門市設定已儲存', 'ok'); pingBridge();
      } catch (e) { toastErr(e); }
    }
    async function testBridge() {
      bridgeTest.value = '測試中…';
      await saveSettings();
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
    const phraseQuery = b => b.eq('store_id', state.storeId).order('sort');
    const phraseDefaults = () => ({ store_id: state.storeId, text: '', sort: 0 });
    return { state, quick, s, newReason, addReason, delReason, moveReason, addDept, deptName, removeDept, moveDept, printMode, PRINT_MODES, bridgeTest, addQuick, saveQuick, delQuick,
      saveSettings, testBridge, testPrint, phraseQuery, phraseDefaults, curStore };
  },
  template: `<div class="wrap wide">
    <div class="page-head"><h2><i class="sl"></i>門市設定</h2><span class="pill store">{{curStore()?.name}}</span></div>
    <div class="grid2" style="grid-template-columns:minmax(0,1.3fr) minmax(0,1fr)">
      <div>
        <div class="card">
          <h3><i class="sl"></i>寄單預設值</h3>
          <p class="small muted" style="margin:0 0 10px">新寄單時自動帶入，仍可逐筆修改。選了過往紀錄則以紀錄為主。</p>
          <div class="form">
            <div class="fld c12"><label>預設通知方式</label><NotifyPicker v-model="s.default_notify" /></div>
            <div class="fld c7"><label>預設醫院</label><HospitalInput v-model:code="s.default_hospital_code" v-model:name="s.default_hospital_name" /></div>
            <div class="fld c5"><label>預設科別</label><DeptInput v-model:code="s.default_dept_code" v-model:name="s.default_dept_name" /></div>
          </div>
          <h3 style="margin-top:16px"><i class="sl"></i>常用科別 <span class="small muted" style="font-weight:500">顯示在寄單畫面的科別欄下方，建議 6～9 個</span></h3>
          <div class="chips" style="margin-bottom:8px">
            <span class="chip static" v-for="(c,i) in s.quick_depts" :key="c"><span class="k">{{c}}</span>{{deptName(c)}}
              <button class="linkbtn" style="text-decoration:none" title="往前" @click="moveDept(i,-1)">‹</button>
              <button class="linkbtn" style="text-decoration:none" title="往後" @click="moveDept(i,1)">›</button>
              <button class="linkbtn" style="text-decoration:none;color:var(--bad)" title="移除" @click="removeDept(c)">✕</button></span>
            <span class="small muted" v-if="!s.quick_depts.length">尚未設定</span>
          </div>
          <div style="max-width:300px"><DeptInput v-model:code="addDept.code" v-model:name="addDept.name" /></div>
          <div class="btns" style="justify-content:flex-end;margin-top:12px"><button class="btn fill" @click="saveSettings">儲存預設值</button></div>
        </div>
        <div class="card">
          <h3><i class="sl"></i>常用醫院快速碼</h3>
          <p class="small muted" style="margin:0 0 10px">寄單時在醫院欄輸入快速碼（例：01）按 Enter 即帶入；寄單畫面會以 5 欄格狀顯示，8～10 間剛好兩列。「顯示簡稱」也會用在標籤和清單上。</p>
          <div class="tbl"><table class="rowedit">
            <thead><tr><th style="width:64px">快速碼</th><th style="min-width:240px">醫院</th><th style="width:100px">顯示簡稱</th><th style="width:170px">預設科別</th><th style="width:60px">排序</th><th style="width:120px"></th></tr></thead>
            <tbody>
              <tr v-for="(x,i) in quick" :key="i" style="cursor:default">
                <td><input class="inp num" v-model="x.quick_code" maxlength="2"></td>
                <td><HospitalInput v-model:code="x.hospital_code" v-model:name="x.name" /></td>
                <td><input class="inp" v-model="x.label" placeholder="例：台大"></td>
                <td><DeptInput v-model:code="x.default_dept" v-model:name="x.dept_name" /></td>
                <td><input class="inp" type="number" v-model="x.sort"></td>
                <td class="nw"><button class="btn xs fill" @click="saveQuick(x)">儲存</button> <button class="btn xs danger" @click="delQuick(x)">刪除</button></td>
              </tr>
              <tr class="empty-row" v-if="!quick.length"><td colspan="6">尚未設定</td></tr>
            </tbody>
          </table></div>
          <button class="btn sm" style="margin-top:10px" @click="addQuick">＋ 新增常用醫院</button>
        </div>
        <div class="card">
          <h3><i class="sl"></i>常用片語（本門市）</h3>
          <CrudTable table="rx_phrases" :reload-key="state.storeId" :query="phraseQuery" :defaults="phraseDefaults"
            :cols="[{key:'text',label:'片語'},{key:'sort',label:'排序',type:'number',w:'90px'}]" />
          <p class="small muted" style="margin-top:10px">全門市共用片語：
            <span class="chip static" v-for="p in state.phrases.filter(p=>!p.store_id)" :key="p.id" style="margin:2px">{{p.text}}</span>
            （由管理員維護）</p>
        </div>
      </div>
      <div>
        <div class="card">
          <h3><i class="sl"></i>本機列印</h3>
          <p class="small muted" style="margin:0 0 10px">每台電腦可各自設定（存在這台電腦的瀏覽器）。建議 Chrome 以 <code>--kiosk-printing</code> 啟動可免跳出列印對話框。</p>
          <div class="inline"><select class="inp" v-model="printMode"><option v-for="m in PRINT_MODES" :key="m.id" :value="m.id">{{m.name}}</option></select>
            <button class="btn" @click="testPrint">測試列印</button></div>
        </div>
        <div class="card">
          <h3><i class="sl"></i>作業參數與通知範本</h3>
          <div class="form">
            <div class="fld c6"><label>預作提前天數</label><input class="inp num" type="number" v-model="s.prep_days_ahead"><span class="hint">預作確認頁預設顯示「今天 + N 天」</span></div>
            <div class="fld c6"><label>最新預作日</label><RocDate v-model="s.last_prep_date" compact />
              <span class="hint">預作確認時自動更新；寄單的領藥日早於或等於此日會提醒「直接打單調劑」。若有誤可在此修正。</span></div>
            <div class="fld c12"><label>取消原因選項 <span class="opt">取消寄單／取消某次時可點選</span></label>
              <div class="chips">
                <span class="chip static" v-for="(t,i) in s.cancel_reasons" :key="t">{{t}}
                  <button class="linkbtn" style="text-decoration:none" title="往前" @click="moveReason(i,-1)">‹</button>
                  <button class="linkbtn" style="text-decoration:none" title="往後" @click="moveReason(i,1)">›</button>
                  <button class="linkbtn" style="text-decoration:none;color:var(--bad)" title="移除" @click="delReason(t)">✕</button></span>
              </div>
              <div class="inline" style="max-width:360px;margin-top:6px"><input class="inp" v-model="newReason" placeholder="新增原因" @keydown.enter.prevent="addReason"><button class="btn sm" @click="addReason">新增</button></div></div>
            <div class="fld c12"><label>通知訊息範本 <span class="opt">空白則用系統預設</span></label>
              <TplInput v-model="s.notify_template" :placeholder="state.settings.notify_template" />
              <span class="hint">同行家人通知時，姓名會自動合併成「王小明、李小美」</span></div>
            <div class="fld c12"><label>發票機單據底部文字</label><input class="inp" v-model="s.receipt_footer" :placeholder="state.settings.receipt_footer"></div>
            <div class="fld c12"><label>本地藥局系統連線（RxBridge）<span class="opt">沒有就留空</span></label>
              <div class="inline"><input class="inp" v-model="s.bridge_url" placeholder="http://localhost:5880"><button class="btn" @click="testBridge">測試連線</button></div>
              <span class="hint">{{bridgeTest || '福原藥局：在櫃台電腦執行 RxBridge 後填 http://localhost:5880，輸入姓名時即可查詢藥局系統病人資料。'}}</span></div>
          </div>
          <div class="btns" style="justify-content:flex-end;margin-top:12px"><button class="btn fill" @click="saveSettings">儲存設定</button></div>
        </div>
      </div>
    </div>
  </div>`,
};
