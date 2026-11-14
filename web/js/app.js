// 處方寄單系統 — 主程式（登入、導覽、路由）
import { createApp, ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { CONFIG } from './config.js';
import { sb, state, q, isAdmin, loadCommon, loadStoreData, refreshCounts, toastErr, ls, cleanErr, confirmLeave, hasUnsaved } from './lib.js';
import { StaffPrompt, OrderDetail, ConfirmModal } from './components.js';
import EntryPage from './pages/entry.js';
import SearchPage from './pages/search.js';
import PrepPage from './pages/prep.js';
import NotifyPage from './pages/notify.js';
import StoreSetPage from './pages/storeset.js';
import AdminPage from './pages/admin.js';

const ROUTES = [
  { id: 'entry', name: '寄單輸入', comp: EntryPage },
  { id: 'search', name: '寄單查詢', comp: SearchPage },
  { id: 'prep', name: '預作確認', comp: PrepPage, badge: 'prep_pending' },
  { id: 'notify', name: '預作通知', comp: NotifyPage, badge: 'to_notify' },
  { id: 'store', name: '門市設定', comp: StoreSetPage },
  { id: 'admin', name: '系統管理', comp: AdminPage, admin: true },
];

// Logo：橘色實心圓＋青綠圓環交疊（取自登入頁的兩個圓）
const BRAND_SVG = `<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="14.5" cy="24" r="10" fill="#ff9933"/><circle cx="25.5" cy="15.5" r="9" fill="none" stroke="#00d0c5" stroke-width="5"/></svg>`;

// ---------------- 螢幕縮放 ----------------
// 自動：以 1440×860 的版面為基準，依視窗寬高等比放大（最大 2 倍、不縮小）；也可手動指定
const ZOOMS = [['auto', '自動'], [1, '100%'], [1.1, '110%'], [1.25, '125%'], [1.4, '140%'], [1.6, '160%'], [1.8, '180%']];
const zoomMode = ref(ls.get('ui_zoom', 'auto'));
function autoZoom() {
  const z = Math.min(window.innerWidth / 1440, window.innerHeight / 860);
  return Math.max(1, Math.min(2, Math.floor(z * 20) / 20));
}
function applyZoom() {
  const z = zoomMode.value === 'auto' ? autoZoom() : Number(zoomMode.value) || 1;
  const el = document.documentElement;
  el.style.zoom = z === 1 ? '' : String(z);
  el.style.setProperty('--z', String(z));
}
watch(zoomMode, v => { ls.set('ui_zoom', v); applyZoom(); });
window.addEventListener('resize', () => { if (zoomMode.value === 'auto') applyZoom(); });
applyZoom();

const Login = {
  setup() {
    const account = ref(ls.get('last_account', ''));
    const password = ref('');
    const busy = ref(false);
    const err = ref('');
    async function login() {
      err.value = '';
      if (!account.value || !password.value) { err.value = '請輸入帳號與密碼'; return; }
      busy.value = true;
      const email = account.value.includes('@') ? account.value.trim() : `${account.value.trim()}@${CONFIG.EMAIL_DOMAIN}`;
      const { error } = await sb.auth.signInWithPassword({ email, password: password.value });
      busy.value = false;
      if (error) { err.value = /Invalid login/i.test(error.message) ? '帳號或密碼錯誤' : cleanErr(error.message); return; }
      ls.set('last_account', account.value.trim());
    }
    return { account, password, busy, err, login, state, CONFIG, BRAND_SVG };
  },
  template: `<div class="login"><div class="card">
    <div class="brand" style="margin-bottom:16px" v-html="BRAND_SVG + '<span>凌曜醫療<small>LINYAO MEDICAL</small></span>'"></div>
    <h1><i class="sl"></i>{{CONFIG.APP_NAME}}</h1>
    <p class="small muted" style="margin:0 0 20px">慢性處方箋寄單 · 預作 · 通知領藥</p>
    <form @submit.prevent="login" class="form">
      <div class="fld c12"><label>帳號</label><input class="inp big" v-model="account" autocomplete="username" autofocus></div>
      <div class="fld c12"><label>密碼</label><input class="inp big" type="password" v-model="password" autocomplete="current-password"></div>
      <div class="fld c12" v-if="err || state.authMsg"><div class="alert err">{{err || state.authMsg}}</div></div>
      <div class="fld c12"><button class="btn fill lg" :disabled="busy" type="submit"><i class="sl"></i>{{busy ? '登入中…' : '登入'}}</button></div>
    </form>
    <div class="foot">Designed by Tom 蔡育霖藥師 · {{CONFIG.VERSION}}</div>
  </div></div>`,
};

const App = {
  components: { Login, StaffPrompt, OrderDetail, ConfirmModal },
  setup() {
    const routes = computed(() => ROUTES.filter(r => !r.admin || isAdmin()));
    const page = computed(() => (routes.value.find(r => r.id === state.route) || routes.value[0]).comp);
    function readHash() {
      const id = location.hash.replace(/^#\/?/, '') || 'entry';
      const to = ROUTES.some(r => r.id === id) ? id : 'entry';
      if (to === state.route) return;
      // 有未儲存的設定 → 先確認；取消就把網址改回原頁
      if (!confirmLeave('離開這個頁面')) { history.replaceState(null, '', '#/' + state.route); return; }
      state.route = to;
    }

    async function afterLogin(user) {
      state.user = user;
      state.authMsg = '';
      try {
        const prof = await q(sb.from('rx_users').select('*').eq('id', user.id).maybeSingle());
        if (!prof || !prof.active) { state.authMsg = '此帳號尚未啟用，請聯絡管理員。'; await sb.auth.signOut(); return; }
        if (prof.role !== 'admin' && !prof.store_id) { state.authMsg = '此帳號尚未指定門市，請聯絡管理員。'; await sb.auth.signOut(); return; }
        state.profile = prof;
        await loadCommon();
        const saved = ls.get('admin_store', null);
        state.storeId = prof.role === 'admin' ? (state.stores.find(s => s.id === saved)?.id || prof.store_id || state.stores[0]?.id) : prof.store_id;
        await loadStoreData();
        refreshCounts();
      } catch (e) { toastErr(e); }
    }
    function clearSession() { state.user = null; state.profile = null; state.staff = []; state.operator = null; state.detailId = null; state.draft = null; state.lastSaved = null; state.searchSaved = null; state.dirty = {}; }

    async function changeStore(e) {
      if (!confirmLeave('切換門市')) { e.target.value = state.storeId; return; }
      state.storeId = e.target.value; ls.set('admin_store', state.storeId);
      state.detailId = null; state.draft = null; state.lastSaved = null;
      await loadStoreData(); refreshCounts();
    }
    async function logout() { if (!confirmLeave('登出')) return; await sb.auth.signOut(); }
    const storeName = computed(() => state.stores.find(s => s.id === state.storeId)?.name || '');

    function onKey(e) { if (e.key === 'Escape' && !state.ask && state.detailId) state.detailId = null; }
    let timer;
    onMounted(async () => {
      readHash();
      window.addEventListener('hashchange', readHash);
      window.addEventListener('keydown', onKey);
      window.addEventListener('beforeunload', e => { if (hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } });
      const { data } = await sb.auth.getSession();
      if (data.session) await afterLogin(data.session.user);
      state.ready = true;
      sb.auth.onAuthStateChange((ev, session) => {
        if (ev === 'SIGNED_IN' && session && session.user.id !== state.user?.id) afterLogin(session.user);
        if (ev === 'SIGNED_OUT') clearSession();
      });
      timer = setInterval(refreshCounts, 60000);
    });
    onBeforeUnmount(() => { clearInterval(timer); window.removeEventListener('keydown', onKey); });
    watch(() => state.tick, () => refreshCounts());

    return { state, routes, page, isAdmin, changeStore, logout, storeName, BRAND_SVG, CONFIG, zoomMode, ZOOMS };
  },
  template: `
    <template v-if="!state.ready"><div class="login"><div class="card"><p class="muted">載入中…</p></div></div></template>
    <Login v-else-if="!state.profile" />
    <template v-else>
      <nav class="nav"><div class="wrap">
        <a class="brand" href="#/entry" v-html="BRAND_SVG + '<span>' + CONFIG.APP_NAME + '<small>凌曜醫療 · LINYAO MEDICAL</small></span>'"></a>
        <ul>
          <li v-for="r in routes" :key="r.id"><a :href="'#/'+r.id" :class="{on: state.route===r.id}">{{r.name}}
            <span class="badge" v-if="r.badge && state.counts[r.badge]">{{state.counts[r.badge]}}</span></a></li>
        </ul>
        <div class="who">
          <select v-if="isAdmin()" :value="state.storeId" @change="changeStore" title="切換作業門市">
            <option v-for="s in state.stores.filter(s=>s.active)" :key="s.id" :value="s.id">{{s.name}}</option></select>
          <span v-else class="pill store">{{storeName}}</span>
          <span class="muted">{{state.profile.display_name || state.profile.account}}</span>
          <select class="zoomsel" v-model="zoomMode" title="畫面大小（自動會依螢幕大小調整）">
            <option v-for="z in ZOOMS" :key="z[0]" :value="z[0]">{{z[0]==='auto' ? '畫面：自動' : '畫面：' + z[1]}}</option></select>
          <button class="btn xs" @click="logout">登出</button>
        </div>
      </div></nav>
      <main><component :is="page" :key="state.route" /></main>
      <div class="foot">處方寄單系統 {{CONFIG.VERSION}} · Designed by Tom 蔡育霖藥師</div>
      <OrderDetail />
    </template>
    <StaffPrompt />
    <ConfirmModal />
    <div class="toasts"><div v-for="t in state.toasts" :key="t.id" class="toast" :class="t.type">{{t.msg}}</div></div>
  `,
};

createApp(App).mount('#app');
