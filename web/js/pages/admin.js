// 系統管理（管理員）：門市、帳號、人員代碼、醫院、科別、全域片語、系統參數
import { ref, reactive, computed, onMounted } from 'vue';
import { sb, state, q, toast, toastErr, loadCommon, loadStoreData, debounce } from '../lib.js';
import { CrudTable, TplInput } from '../components.js';

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
  components: { CrudTable, CsvImport, TplInput },
  setup() {
    const tab = ref('stores');
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

    // 帳號建立（Edge Function：rx-admin-users）
    const nu = reactive({ account: '', password: '', display_name: '', role: 'store', store_id: '' });
    const uKey = ref(0);
    async function callFn(body) {
      const { data, error } = await sb.functions.invoke('rx-admin-users', { body });
      if (error) {
        let m = error.message;
        try { m = (await error.context.json()).error || m; } catch { /* ignore */ }
        throw new Error(/Failed to send|not found|404/i.test(m) ? '尚未部署 Edge Function「rx-admin-users」，請見 README；或先在 Supabase 後台 Authentication 新增使用者' : m);
      }
      if (data?.error) throw new Error(data.error);
      return data;
    }
    async function createUser() {
      if (!nu.account || !nu.password) return toast('請輸入帳號與密碼', 'err');
      try { await callFn({ action: 'create', ...nu, store_id: nu.store_id || null }); toast('帳號已建立', 'ok'); Object.assign(nu, { account: '', password: '', display_name: '' }); uKey.value++; }
      catch (e) { toastErr(e); }
    }
    async function resetPw() {
      const account = prompt('要重設密碼的帳號：'); if (!account) return;
      const password = prompt(`「${account}」的新密碼：`); if (!password) return;
      try { await callFn({ action: 'reset_password', account, password }); toast('密碼已重設', 'ok'); } catch (e) { toastErr(e); }
    }

    // 系統參數
    const gs = reactive({ notify_template: '', receipt_footer: '', prep_days_ahead: 7 });
    function loadGs() { for (const k in gs) if (state.settings[k] !== undefined) gs[k] = state.settings[k]; }
    async function saveGs() {
      try {
        const rows = Object.entries(gs).map(([key, value]) => ({ key, value: key.endsWith('days') ? Number(value) || 7 : value, updated_at: new Date().toISOString() }));
        await q(sb.from('rx_settings').upsert(rows, { onConflict: 'key' }));
        await loadCommon(); toast('系統參數已儲存', 'ok');
      } catch (e) { toastErr(e); }
    }
    onMounted(loadGs);

    return { state, tab, storeOpts, staffStoreOpts, hq, hKey, setHq, hospQuery, reloadAll, nu, uKey, createUser, resetPw, gs, saveGs };
  },
  template: `<div class="wrap">
    <div class="page-head"><h2><i class="sl"></i>系統管理</h2></div>
    <div class="subnav">
      <button v-for="(t,k) in {stores:'門市',users:'帳號',staff:'人員代碼',hosp:'醫院清單',dept:'科別清單',phrase:'全域片語',params:'系統參數'}"
        :key="k" :class="{on:tab===k}" @click="tab=k">{{t}}</button>
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
          <div class="fld c2"><label>帳號</label><input class="inp" v-model="nu.account" placeholder="fuyuan"></div>
          <div class="fld c2"><label>密碼</label><input class="inp" v-model="nu.password"></div>
          <div class="fld c3"><label>顯示名稱</label><input class="inp" v-model="nu.display_name" placeholder="福原藥局"></div>
          <div class="fld c2"><label>角色</label><select class="inp" v-model="nu.role"><option value="store">門市</option><option value="admin">管理員</option></select></div>
          <div class="fld c2"><label>門市</label><select class="inp" v-model="nu.store_id"><option value="">（無）</option><option v-for="s in state.stores" :key="s.id" :value="s.id">{{s.name}}</option></select></div>
          <div class="fld c1" style="grid-column:span 1"><button class="btn fill" @click="createUser">建立</button></div>
        </div>
        <p class="small muted" style="margin:10px 0 0">門市使用固定共用帳號即可；實際操作人員以「人員代碼」區分。<button class="linkbtn" @click="resetPw">重設某帳號密碼</button></p>
      </div>
      <div class="card">
        <CrudTable table="rx_users" :reload-key="uKey" :can-add="false" :can-delete="false" :query="b=>b.order('account')"
          hint="從 Supabase 後台新增的使用者也會自動出現在這裡，指定角色與門市即可使用。"
          :cols="[{key:'account',label:'帳號',readonly:true},{key:'display_name',label:'顯示名稱'},{key:'role',label:'角色',type:'select',options:[{v:'store',t:'門市'},{v:'admin',t:'管理員'}],w:'110px'},{key:'store_id',label:'門市',type:'select',options:storeOpts,w:'180px'},{key:'active',label:'啟用',type:'bool',w:'60px'}]" />
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
      <CrudTable table="rx_phrases" :query="b=>b.is('store_id',null).order('sort')" @vue:unmounted="reloadAll"
        :defaults="()=>({store_id:null,text:'',sort:0})" hint="全門市共用的備註片語；各門市另可在「門市設定」新增自己的。"
        :cols="[{key:'text',label:'片語'},{key:'sort',label:'排序',type:'number',w:'90px'}]" />
    </div>

    <div class="card" v-if="tab==='params'">
      <div class="form">
        <div class="fld c3"><label>預設預作提前天數</label><input class="inp num" type="number" v-model.number="gs.prep_days_ahead"></div>
        <div class="fld c12"><label>預設通知訊息範本</label><TplInput v-model="gs.notify_template" />
          <span class="hint">門市可在「門市設定」覆寫</span></div>
        <div class="fld c12"><label>預設發票機單據底部文字</label><input class="inp" v-model="gs.receipt_footer"></div>
      </div>
      <div class="btns" style="justify-content:flex-end;margin-top:12px"><button class="btn fill" @click="saveGs">儲存</button></div>
    </div>
  </div>`,
};
