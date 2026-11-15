// 系統管理（管理員）：門市、帳號、人員代碼、醫院、科別、全域片語、系統參數
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { sb, state, q, rpc, toast, toastErr, loadCommon, loadStoreData, debounce, useDirty, copyText, dtOf } from '../lib.js';
import { CONFIG } from '../config.js';
import { CrudTable, TplInput, PhraseEditor, UnsavedBar, loadPhraseList, savePhraseList } from '../components.js';

function parseCsv(text) {
  const rows = []; let row = [], cur = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inQ = false; } else cur += c; }
    else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}

const CsvImport = {
  props: { table: String, label: String },
  emits: ['done'],
  setup(props, { emit }) {
    const msg = ref('');
    async function onFile(e) {
      const file = e.target.files[0]; e.target.value = '';
      if (!file) return;
      const rows = parseCsv((await file.text()).replace(/^﻿/, ''));
      const head = rows.shift().map(h => h.trim().toLowerCase());
      const ci = head.findIndex(h => /(_no|code|代號|代碼)$/.test(h));
      const ni = head.findIndex(h => /(name|名稱)$/.test(h));
      if (ci < 0 || ni < 0) { toast('找不到代碼與名稱欄位（需有 xxx_no / xxx_name 欄）', 'err'); return; }
      const items = new Map();
      for (const r of rows) { const c = (r[ci] || '').trim(), n = (r[ni] || '').trim(); if (c && n && c !== n) items.set(c, n); }
      if (!confirm(`將匯入／更新 ${items.size} 筆${props.label}，確定？`)) return;
      const list = [...items].map(([code, name]) => ({ code, name }));
      let done = 0;
      try {
        for (let i = 0; i < list.length; i += 500) {
          await q(sb.from(props.table).upsert(list.slice(i, i + 500), { onConflict: 'code' }));
          done += Math.min(500, list.length - i); msg.value = `匯入中 ${done}/${list.length}`;
        }
        msg.value = `✓ 完成 ${done} 筆`; emit('done');
      } catch (er) { toastErr(er); msg.value = `中斷於 ${done} 筆`; }
    }
    return { msg, onFile };
  },
  template: `<label class="btn sm">匯入 CSV<input type="file" accept=".csv,text/csv" hidden @change="onFile"></label> <span class="small muted">{{msg}}</span>`,
};

export default {
  components: { CrudTable, CsvImport, TplInput, PhraseEditor, UnsavedBar },
  setup() {
    const tab = ref('stores');
    // 切換分頁：表格類分頁（門市、人員代碼、醫院、科別）切走會放棄未儲存的變更，先確認
    function switchTab(k) {
      if (k === tab.value) return;
      const crudDirty = Object.entries(state.dirty).some(([key, v]) => v && key.startsWith('crud:'));
      if (crudDirty && !confirm('這個分頁還有未儲存的變更，切換分頁會放棄這些變更，確定？')) return;
      tab.value = k;
    }
    const storeOpts = () => [{ v: null, t: '（未指定）' }, ...state.stores.map(s => ({ v: s.id, t: `${s.id} ${s.name}` }))];
    const staffStoreOpts = () => [{ v: null, t: '全門市通用' }, ...state.stores.map(s => ({ v: s.id, t: `${s.id} ${s.name}` }))];
    const hq = ref('');
    const hKey = ref(0);
    const setHq = debounce(() => hKey.value++, 300);
    const hospQuery = b => {
      const s = hq.value.replace(/[,()*%\\]/g, '').trim();
      return s ? b.or(`code.like.${s}%,name.ilike.%${s}%`).order('name').limit(100) : b.order('updated_at', { ascending: false }).limit(50);
    };
    const reloadAll = async () => { await loadCommon(); await loadStoreData(); };

    // ---------- 帳號管理（Edge Function：rx-admin-users，做法與調撥系統相同） ----------
    const nu = reactive({ account: '', password: '', password2: '', display_name: '', role: 'store', store_id: '' });
    const showPw = ref(false);
    const users = ref([]);
    const uBusy = ref(false);
    const pw = reactive({ open: false, user: null, value: '', value2: '', show: false });
    async function callFn(body) {
      const { data, error } = await sb.functions.invoke('rx-admin-users', { body });
      if (error) {
        let m = error.message || '';
        try { m = (await error.context.json()).error || m; } catch { /* 不是 JSON 回應 */ }
        const status = error.context?.status;
        if (status === 404 && !/使用者/.test(m)) throw new Error('找不到 Edge Function「rx-admin-users」：請確認已部署在同一個 Supabase 專案，且名稱完全相同');
        throw new Error(m || '操作失敗');
      }
      if (data?.error) throw new Error(data.error);
      return data;
    }
    async function loadUsers() {
      try {
        const rows = await q(sb.from('rx_users').select('*').order('role').order('account'));
        users.value = rows.map(u => ({ ...u, _o: JSON.stringify({ a: u.account, d: u.display_name, r: u.role, s: u.store_id }) }));
      } catch (e) { toastErr(e); }
    }
    const uDirty = u => JSON.stringify({ a: u.account, d: u.display_name, r: u.role, s: u.store_id }) !== u._o;
    const usersDirty = computed(() => users.value.filter(uDirty));
    async function createUser() {
      if (!nu.account || !nu.password) return toast('請輸入帳號與密碼', 'err');
      if (nu.password.length < 6) return toast('密碼至少 6 碼', 'err');
      if (nu.password !== nu.password2) return toast('兩次輸入的密碼不一致', 'err');
      if (nu.role === 'store' && !nu.store_id) return toast('門市帳號需要指定門市', 'err');
      if (usersDirty.value.length) return toast('帳號清單有未儲存的修改，請先按「儲存全部」再建立新帳號', 'warn');
      uBusy.value = true;
      try {
        const { password2, ...body } = nu;
        await callFn({ action: 'create', ...body, store_id: nu.store_id || null });
        toast(`已建立帳號 ${nu.account}`, 'ok');
        Object.assign(nu, { account: '', password: '', password2: '', display_name: '' }); showPw.value = false;
        await loadUsers();
      } catch (e) { toastErr(e); } finally { uBusy.value = false; }
    }
    async function saveUsers() {
      for (const u of usersDirty.value) {
        await callFn({ action: 'update', userId: u.id, account: u.account, display_name: u.display_name, role: u.role, store_id: u.store_id || null });
        u._o = JSON.stringify({ a: u.account, d: u.display_name, r: u.role, s: u.store_id });
      }
    }
    async function toggleActive(u) {
      if (uDirty(u)) return toast('這個帳號有未儲存的修改，請先按「儲存全部」', 'warn');
      const to = !u.active;
      if (!to && !confirm(`停用帳號「${u.account}」？停用後無法登入。`)) return;
      uBusy.value = true;
      try { await callFn({ action: 'set_active', userId: u.id, active: to }); toast(to ? '已啟用' : '已停用', 'ok'); await loadUsers(); }
      catch (e) { toastErr(e); } finally { uBusy.value = false; }
    }
    function openPw(u) { Object.assign(pw, { open: true, user: u, value: '', value2: '', show: false }); }
    async function submitPw() {
      if (!pw.value) return toast('請輸入新密碼', 'err');
      if (pw.value.length < 6) return toast('密碼至少 6 碼', 'err');
      if (pw.value !== pw.value2) return toast('兩次輸入的密碼不一致', 'err');
      uBusy.value = true;
      try { await callFn({ action: 'reset_password', userId: pw.user.id, password: pw.value }); toast(`已修改 ${pw.user.account} 的密碼`, 'ok'); pw.open = false; }
      catch (e) { toastErr(e); } finally { uBusy.value = false; }
    }
    const storeName = id => state.stores.find(s => s.id === id)?.name || '';

    // 系統參數
    const gs = reactive({ notify_template: '', receipt_footer: '', prep_days_ahead: 7 });
    const gsOrig = ref('');
    function loadGs() { for (const k in gs) if (state.settings[k] !== undefined) gs[k] = state.settings[k]; gsOrig.value = JSON.stringify(gs); }
    const gsDirty = computed(() => JSON.stringify(gs) !== gsOrig.value);
    async function saveGs() {
      const rows = Object.entries(gs).map(([key, value]) => ({ key, value: key.endsWith('days') ? Number(value) || 7 : value, updated_at: new Date().toISOString() }));
      await q(sb.from('rx_settings').upsert(rows, { onConflict: 'key' }));
      await loadCommon(); loadGs();
    }

    // 全域片語
    const phr = ref([]);
    const phrOrig = ref([]);
    async function loadPhr() { try { phrOrig.value = await loadPhraseList(null); phr.value = phrOrig.value.map(r => ({ ...r })); } catch (e) { toastErr(e); } }
    const phrKey = l => JSON.stringify(l.map(r => [r.id, r.text]));
    const phrDirty = computed(() => phrKey(phr.value) !== phrKey(phrOrig.value));

    // 帳號／全域片語／系統參數：統一按「儲存全部」
    const aDirtyCount = computed(() => usersDirty.value.length + (phrDirty.value ? 1 : 0) + (gsDirty.value ? 1 : 0));
    useDirty('admin', computed(() => aDirtyCount.value > 0));
    const aBusy = ref(false);
    async function saveAdmin() {
      aBusy.value = true;
      try {
        if (usersDirty.value.length) await saveUsers();
        if (phrDirty.value) { await savePhraseList(null, phrOrig.value, phr.value); await loadPhr(); loadStoreData(); }
        if (gsDirty.value) await saveGs();
        toast('已全部儲存', 'ok', 1600);
        await loadUsers();
      } catch (e) { toastErr(e); } finally { aBusy.value = false; }
    }
    function discardAdmin() {
      if (!confirm('放棄帳號、全域片語、系統參數的未儲存變更？')) return;
      loadUsers(); loadPhr(); loadGs();
    }
    // 調劑系統串接：門市 API 金鑰（產生、停用為立即動作）
    const keys = ref([]);
    const nk = reactive({ store_id: '', name: '' });
    const newKey = ref(null);           // { key, store, name } 只顯示這一次
    async function loadKeys() {
      try { keys.value = await q(sb.from('rx_api_keys').select('*').order('store_id').order('created_at')); } catch (e) { toastErr(e); }
    }
    async function createKey() {
      if (!nk.store_id) return toast('請選擇門市', 'err');
      try {
        const k = await rpc('rx_api_key_create', { p_store: nk.store_id, p_name: nk.name || '調劑電腦' });
        newKey.value = { key: k, store: storeName(nk.store_id), name: nk.name || '調劑電腦' };
        nk.name = ''; await loadKeys();
      } catch (e) { toastErr(e); }
    }
    async function toggleKey(k) {
      if (k.active && !confirm(`停用「${storeName(k.store_id)} ${k.name}」的金鑰？停用後該電腦無法再送寄單。`)) return;
      try { await q(sb.from('rx_api_keys').update({ active: !k.active }).eq('id', k.id)); await loadKeys(); toast(k.active ? '已停用' : '已啟用', 'ok', 1400); } catch (e) { toastErr(e); }
    }
    const apiBase = CONFIG.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1/rpc/rx_intake';
    watch(tab, t => { if (t === 'apikeys') loadKeys(); });
    onMounted(() => { loadGs(); loadUsers(); loadPhr(); });

    return { keys, nk, newKey, createKey, toggleKey, apiBase, CONFIG, copyText, dtOf, switchTab, usersDirty, phr, aDirtyCount, aBusy, saveAdmin, discardAdmin, state, tab, storeOpts, staffStoreOpts, hq, hKey, setHq, hospQuery, reloadAll, nu, showPw, users, uBusy, pw, uDirty,
      createUser, toggleActive, openPw, submitPw, loadUsers, storeName, gs, saveGs };
  },
  template: `<div class="wrap">
    <div class="page-head"><h2><i class="sl"></i>系統管理</h2></div>
    <div class="subnav">
      <button v-for="(t,k) in {stores:'門市',users:'帳號',staff:'人員代碼',hosp:'醫院清單',dept:'科別清單',phrase:'全域片語',params:'系統參數',apikeys:'調劑串接'}"
        :key="k" :class="{on:tab===k}" @click="switchTab(k)">{{t}}</button>
    </div>

    <div class="card" v-if="tab==='stores'">
      <CrudTable table="rx_stores" :pk="['id']" :query="b=>b.order('sort')" @vue:unmounted="reloadAll"
        :defaults="()=>({id:'',name:'',short_name:'',sort:state.stores.length+1,active:true})"
        hint="門市代碼建議與藥局系統一致（例：03 福原、04 日新）。各門市作業參數請到「門市設定」。"
        :cols="[{key:'id',label:'代碼',pkLock:true,w:'90px'},{key:'name',label:'門市名稱'},{key:'short_name',label:'簡稱',w:'120px'},{key:'sort',label:'排序',type:'number',w:'80px'},{key:'active',label:'啟用',type:'bool',w:'60px'}]" />
    </div>

    <template v-if="tab==='users'">
      <div class="card">
        <h3><i class="sl"></i>新增帳號</h3>
        <div class="form" style="align-items:end">
          <div class="fld c2"><label>帳號</label><input class="inp" v-model="nu.account" placeholder="fuyuan" autocomplete="off"></div>
          <div class="fld c2"><label>密碼 <span class="opt">至少 6 碼</span></label>
            <div class="pwbox"><input class="inp" :type="showPw ? 'text' : 'password'" v-model="nu.password" autocomplete="new-password">
              <button type="button" class="eye" :title="showPw ? '隱藏' : '顯示'" @click="showPw=!showPw">{{showPw ? '🙈' : '👁'}}</button></div></div>
          <div class="fld c2"><label>確認密碼</label><input class="inp" :class="{err: nu.password2 && nu.password2!==nu.password}" :type="showPw ? 'text' : 'password'" v-model="nu.password2" autocomplete="new-password"></div>
          <div class="fld c2"><label>顯示名稱</label><input class="inp" v-model="nu.display_name" placeholder="福原藥局"></div>
          <div class="fld" style="grid-column:span 1"><label>角色</label><select class="inp" v-model="nu.role"><option value="store">門市</option><option value="admin">管理員</option></select></div>
          <div class="fld c2"><label>門市</label><select class="inp" v-model="nu.store_id"><option value="">（無）</option><option v-for="s in state.stores" :key="s.id" :value="s.id">{{s.name}}</option></select></div>
          <div class="fld" style="grid-column:span 1"><button class="btn fill" :disabled="uBusy" @click="createUser">建立</button></div>
        </div>
        <p class="small muted" style="margin:10px 0 0">門市使用固定共用帳號即可；實際操作人員以「人員代碼」區分。登入時輸入帳號即可（系統會自動補上 @rx.linyao.local）。</p>
      </div>
      <div class="card">
        <div class="btns" style="margin-bottom:8px"><h3 style="margin:0"><i class="sl"></i>帳號清單</h3><span style="flex:1"></span>
          <button class="btn sm ghost" :disabled="usersDirty.length>0" @click="loadUsers">重新整理</button></div>
        <div class="tbl"><table class="rowedit">
          <thead><tr><th style="width:150px">帳號</th><th>顯示名稱</th><th style="width:120px">角色</th><th style="width:180px">門市</th><th style="width:80px">狀態</th><th style="width:200px"></th></tr></thead>
          <tbody>
            <tr v-for="u in users" :key="u.id" style="cursor:default" :class="{sel: uDirty(u), done: !u.active}">
              <td><input class="inp" v-model="u.account"></td>
              <td><input class="inp" v-model="u.display_name"></td>
              <td><select class="inp" v-model="u.role"><option value="store">門市</option><option value="admin">管理員</option></select></td>
              <td><select class="inp" v-model="u.store_id"><option :value="null">（未指定）</option><option v-for="s in state.stores" :key="s.id" :value="s.id">{{s.id}} {{s.name}}</option></select></td>
              <td><span class="pill" :class="u.active ? 'notified' : 'cancelled'">{{u.active ? '啟用' : '停用'}}</span></td>
              <td class="nw">
                <button class="btn xs" :disabled="uBusy" @click="openPw(u)">修改密碼</button>
                <button class="btn xs" :class="u.active ? 'danger' : ''" :disabled="uBusy" @click="toggleActive(u)">{{u.active ? '停用' : '啟用'}}</button>
              </td>
            </tr>
            <tr class="empty-row" v-if="!users.length"><td colspan="6">尚無帳號</td></tr>
          </tbody>
        </table></div>
        <p class="small muted" style="margin-top:8px">在 Supabase 後台 Authentication 新增的 @rx.linyao.local 使用者也會出現在這裡，指定角色與門市後即可使用。</p>
      </div>
      <div class="mask" v-if="pw.open" @mousedown.self="pw.open=false">
        <div class="modal" style="width:min(380px,100%)">
          <header><h3><i class="sl"></i>修改密碼</h3><button class="x" @click="pw.open=false">取消</button></header>
          <p class="small">帳號：<b>{{pw.user.account}}</b>　{{pw.user.display_name}}</p>
          <div class="lbl" style="margin:8px 0 4px">新密碼 <span class="opt">至少 6 碼</span></div>
          <div class="pwbox"><input class="inp big" :type="pw.show ? 'text' : 'password'" v-model="pw.value" autocomplete="new-password">
            <button type="button" class="eye" @click="pw.show=!pw.show">{{pw.show ? '🙈' : '👁'}}</button></div>
          <div class="lbl" style="margin:10px 0 4px">再輸入一次</div>
          <input class="inp big" :class="{err: pw.value2 && pw.value2!==pw.value}" :type="pw.show ? 'text' : 'password'" v-model="pw.value2" autocomplete="new-password" @keydown.enter="submitPw">
          <div class="btns" style="justify-content:flex-end;margin-top:14px"><button class="btn fill" :disabled="uBusy" @click="submitPw">確認修改</button></div>
        </div>
      </div>
    </template>

    <div class="card" v-if="tab==='staff'">
      <CrudTable table="rx_staff" :query="b=>b.order('store_id',{nullsFirst:true}).order('code')" @vue:unmounted="reloadAll"
        :defaults="()=>({store_id:state.storeId,code:'',name:'',active:true})"
        hint="存檔、預作、通知時輸入的代碼。設成「全門市通用」可在每間門市使用（例：支援藥師）。"
        :cols="[{key:'store_id',label:'門市',type:'select',options:staffStoreOpts,w:'200px'},{key:'code',label:'人員代碼',w:'140px'},{key:'name',label:'姓名'},{key:'active',label:'啟用',type:'bool',w:'60px'}]" />
    </div>

    <div class="card" v-if="tab==='hosp'">
      <div class="btns" style="margin-bottom:10px">
        <input class="inp" style="max-width:320px" v-model="hq" @input="setHq" placeholder="搜尋名稱或院所代號">
        <CsvImport table="rx_hospitals" label="醫院" @done="hKey++" />
        <span class="small muted">CSV 欄位：hsp_name, hsp_no（同代號會更新名稱）</span>
      </div>
      <CrudTable table="rx_hospitals" :pk="['code']" :reload-key="hKey" :query="hospQuery" :can-delete="false"
        :defaults="()=>({code:'',name:'',short_name:'',active:true})"
        :cols="[{key:'code',label:'院所代號',pkLock:true,w:'140px'},{key:'name',label:'名稱'},{key:'short_name',label:'簡稱（搜尋用）',w:'180px'},{key:'active',label:'啟用',type:'bool',w:'60px'}]" />
    </div>

    <div class="card" v-if="tab==='dept'">
      <div class="btns" style="margin-bottom:10px"><CsvImport table="rx_departments" label="科別" @done="reloadAll" /><span class="small muted">CSV 欄位：dep_name, dep_no</span></div>
      <CrudTable table="rx_departments" :pk="['code']" :query="b=>b.order('sort')" @vue:unmounted="reloadAll"
        :defaults="()=>({code:'',name:'',sort:99,active:true})"
        :cols="[{key:'code',label:'代碼',pkLock:true,w:'90px'},{key:'name',label:'科別'},{key:'sort',label:'排序',type:'number',w:'90px'},{key:'active',label:'啟用',type:'bool',w:'60px'}]" />
    </div>

    <div class="card" v-if="tab==='phrase'">
      <p class="small muted" style="margin:0 0 10px">全門市共用的備註片語（拖拉調整順序，完成後按「儲存全部」）；各門市另可在「門市設定」新增自己的。</p>
      <PhraseEditor v-model="phr" />
    </div>

    <div class="card" v-if="tab==='params'">
      <div class="form">
        <div class="fld c3"><label>預設預作提前天數</label><input class="inp num" type="number" v-model.number="gs.prep_days_ahead"></div>
        <div class="fld c12"><label>預設通知訊息範本</label><TplInput v-model="gs.notify_template" />
          <span class="hint">門市可在「門市設定」覆寫</span></div>
        <div class="fld c12"><label>預設發票機單據底部文字</label><input class="inp" v-model="gs.receipt_footer"></div>
      </div>
    </div>

    <template v-if="tab==='apikeys'">
      <div class="card">
        <h3><i class="sl"></i>產生 API 金鑰</h3>
        <p class="small muted" style="margin:0 0 10px">調劑輸出程式用這組金鑰把寄單送進系統。每間門市（或每台調劑電腦）一組，寄單一律建在金鑰所屬門市。</p>
        <div class="form" style="align-items:end">
          <div class="fld c3"><label>門市</label><select class="inp" v-model="nk.store_id"><option value="">請選擇</option>
            <option v-for="s in state.stores" :key="s.id" :value="s.id">{{s.id}} {{s.name}}</option></select></div>
          <div class="fld c4"><label>名稱 <span class="opt">例：福原 調劑電腦 1</span></label><input class="inp" v-model="nk.name"></div>
          <div class="fld c2"><button class="btn fill" @click="createKey">產生金鑰</button></div>
        </div>
        <div class="alert ok" v-if="newKey" style="margin-top:12px">
          <div><b>{{newKey.store}} {{newKey.name}}</b> 的金鑰（<b>只會顯示這一次</b>，請複製到調劑輸出程式的設定）：</div>
          <div class="btns" style="margin-top:6px"><code class="keybox">{{newKey.key}}</code>
            <button class="btn sm" @click="copyText(newKey.key)">複製</button>
            <button class="btn sm ghost" @click="newKey=null">我已複製</button></div>
        </div>
      </div>
      <div class="card">
        <div class="btns" style="margin-bottom:8px"><h3 style="margin:0"><i class="sl"></i>金鑰清單</h3></div>
        <div class="tbl"><table>
          <thead><tr><th style="width:140px">門市</th><th>名稱</th><th style="width:150px">金鑰開頭</th><th style="width:150px">建立</th><th style="width:150px">最後使用</th><th style="width:80px">狀態</th><th style="width:90px"></th></tr></thead>
          <tbody>
            <tr v-for="k in keys" :key="k.id" style="cursor:default" :class="{done: !k.active}">
              <td>{{k.store_id}} {{storeName(k.store_id)}}</td><td>{{k.name}}</td><td class="num">{{k.key_prefix}}…</td>
              <td class="num small">{{dtOf(k.created_at)}}</td><td class="num small">{{k.last_used_at ? dtOf(k.last_used_at) : '—'}}</td>
              <td><span class="pill" :class="k.active ? 'notified' : 'cancelled'">{{k.active ? '啟用' : '停用'}}</span></td>
              <td><button class="btn xs" :class="k.active ? 'danger' : ''" @click="toggleKey(k)">{{k.active ? '停用' : '啟用'}}</button></td>
            </tr>
            <tr class="empty-row" v-if="!keys.length"><td colspan="7">尚未產生金鑰</td></tr>
          </tbody>
        </table></div>
      </div>
      <div class="card">
        <h3><i class="sl"></i>調劑輸出程式設定值</h3>
        <table class="kv small">
          <tr><td>API 網址</td><td><code>{{apiBase}}</code> <button class="btn xs" @click="copyText(apiBase)">複製</button></td></tr>
          <tr><td>apikey（anon key）</td><td><code class="ell" style="max-width:520px;display:inline-block;vertical-align:bottom">{{CONFIG.SUPABASE_ANON_KEY}}</code> <button class="btn xs" @click="copyText(CONFIG.SUPABASE_ANON_KEY)">複製</button></td></tr>
          <tr><td>門市 API 金鑰</td><td>上方產生的 rxk_ 開頭金鑰</td></tr>
        </table>
        <p class="small muted" style="margin-top:8px">anon key 本來就公開在網頁裡，真正的權限由門市 API 金鑰控管；金鑰外洩時在上方停用後重新產生即可。</p>
      </div>
    </template>

    <UnsavedBar :dirty="aDirtyCount>0" :busy="aBusy" :count="aDirtyCount" @save="saveAdmin" @discard="discardAdmin" />
  </div>`,
};
