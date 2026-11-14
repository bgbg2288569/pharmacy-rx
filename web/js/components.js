// 共用元件：民國日期輸入、醫院/科別選擇、通知方式、人員代碼視窗、寄單表單、寄單明細抽屜
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import {
  sb, state, q, rpc, toast, toastErr, NOTIFY, NOTIFY_CLS, FILL_STATUS, ORDER_STATUS, ACTION_LABEL, CIRCLED,
  parseRocInput, rocOf, fullOf, weekOf, addDays, todayISO, diffDays, dtOf, dayOf, fmtNo, onlyDigits, debounce,
  findStaff, askStaff, bridgeSearch, bump, storeSetting, isoOf, parseISO, fillTpl, copyText, shortHosp, ageOf, birthOf, selfOnly,
  parseBirthInput, birthMatch, isMasked, focusNext, askConfirm, DEFAULT_CANCEL_REASONS,
} from './lib.js';
import { printOrder, getPrintMode, setPrintMode, PRINT_MODES } from './print.js';

// ---------------------------------------------------------------- 民國年日曆（取代瀏覽器的西元日期選擇器）
export const RocCalendar = {
  props: { modelValue: String, birth: Boolean, up: Boolean },
  emits: ['pick', 'close'],
  setup(props, { emit }) {
    const init = props.modelValue && !isMasked(props.modelValue) ? parseISO(props.modelValue) : props.birth ? new Date(new Date().getFullYear() - 50, 0, 1) : new Date();
    const y = ref(init.getFullYear());
    const m = ref(init.getMonth());
    const ty = new Date().getFullYear();
    const years = computed(() => {
      const a = props.birth ? ty - 110 : ty - 3, b = props.birth ? ty : ty + 2;
      const out = []; for (let i = b; i >= a; i--) out.push(i); return out;
    });
    const cells = computed(() => {
      const first = new Date(y.value, m.value, 1).getDay();
      const n = new Date(y.value, m.value + 1, 0).getDate();
      const out = Array(first).fill(null);
      for (let d = 1; d <= n; d++) out.push(isoOf(new Date(y.value, m.value, d)));
      while (out.length % 7) out.push(null);
      return out;
    });
    function move(n) { const d = new Date(y.value, m.value + n, 1); y.value = d.getFullYear(); m.value = d.getMonth(); }
    const today = todayISO();
    return { y, m, years, cells, move, today, emit };
  },
  template: `<div class="rcal" :class="{up}" @mousedown.stop @keydown.esc.stop="emit('close')">
    <div class="rch">
      <button type="button" class="nav" @click="move(-1)" title="上個月">‹</button>
      <span class="roc">民國</span><select v-model.number="y"><option v-for="yy in years" :key="yy" :value="yy">{{yy-1911}} 年</option></select>
      <select v-model.number="m"><option v-for="mm in 12" :key="mm" :value="mm-1">{{mm}} 月</option></select>
      <button type="button" class="nav" @click="move(1)" title="下個月">›</button>
    </div>
    <div class="rcg wk"><span v-for="w in '日一二三四五六'" :key="w">{{w}}</span></div>
    <div class="rcg">
      <button type="button" v-for="(c,i) in cells" :key="i" :disabled="!c" :class="{sel: c && c===modelValue, today: c===today, sun: i%7===0, sat: i%7===6}"
        @click="c && emit('pick', c)">{{ c ? Number(c.slice(8)) : '' }}</button>
    </div>
    <div class="rcf"><button type="button" class="linkbtn" v-if="!birth" @click="emit('pick', today)">今天</button><span style="flex:1"></span>
      <button type="button" class="linkbtn" @click="emit('close')">關閉</button></div>
  </div>`,
};

// ---------------------------------------------------------------- 民國日期（畫面顯示 MM/DD）
export const RocDate = {
  props: {
    modelValue: String, prev: String, disabled: Boolean, birth: Boolean, compact: Boolean,
    placeholder: { type: String, default: '例 1120 或 1151120' },
  },
  emits: ['update:modelValue'],
  components: { RocCalendar },
  setup(props, { emit }) {
    const show = v => (v ? fullOf(v) : '');     // 輸入框一律顯示完整民國日期 115/11/20
    const calOpen = ref(false);
    const calUp = ref(false);
    const wrap = ref(null);
    const outside = e => { if (wrap.value && !wrap.value.contains(e.target)) calOpen.value = false; };
    watch(calOpen, o => { if (o) document.addEventListener('mousedown', outside); else document.removeEventListener('mousedown', outside); });
    onBeforeUnmount(() => document.removeEventListener('mousedown', outside));
    const text = ref(show(props.modelValue));
    let shown = text.value;               // 目前顯示字串；沒改過就不重新解析（避免 MM/DD 被推算成別的年份）
    const err = ref(false);
    const picker = ref(null);
    const input = ref(null);
    watch(() => props.modelValue, v => { text.value = shown = show(v); err.value = false; });
    function commit() {
      if (text.value === shown) return true;
      const v = props.birth ? parseBirthInput(text.value) : parseRocInput(text.value);
      if (v === null) { err.value = true; return false; }
      err.value = false;
      text.value = shown = show(v);
      if ((v || '') !== (props.modelValue || '')) emit('update:modelValue', v || '');
      return true;
    }
    function onKey(e) {
      if (e.key === 'Enter' && !commit()) {
        e.stopPropagation(); e.preventDefault();
        toast(props.birth ? '生日格式錯誤，例：0750312、75/**/12' : '日期格式錯誤，例：1120 或 1151120', 'err');
      }
    }
    function openPicker() {
      if (props.disabled) return;
      if (!calOpen.value && wrap.value) calUp.value = window.innerHeight - wrap.value.getBoundingClientRect().bottom < 330;
      calOpen.value = !calOpen.value;
    }
    function fromCal(v) { calOpen.value = false; emit('update:modelValue', v); input.value?.focus(); }
    const plus = n => emit('update:modelValue', addDays(props.prev, n));
    // 日期只能輸入數字和 /；生日另可輸入 *（醫院隱碼）
    function onInput(e) {
      const v = e.target.value.replace(props.birth ? /[^\d\/*]/g : /[^\d\/]/g, '');
      if (v !== e.target.value) e.target.value = v;
      text.value = v;
    }
    const clear = () => { text.value = shown = ''; emit('update:modelValue', ''); input.value?.focus(); };
    const suffix = computed(() => {
      if (!props.modelValue || props.compact) return '';
      return props.birth ? '' : '週' + weekOf(props.modelValue);
    });
    const rel = computed(() => {
      if (!props.modelValue || props.birth || props.compact) return '';
      const d = diffDays(props.modelValue, todayISO());
      return d === 0 ? '今天' : d > 0 ? `${d}天後` : `${-d}天前`;
    });
    const full = computed(() => (props.modelValue ? '民國 ' + fullOf(props.modelValue) + (isMasked(props.modelValue) ? '（含隱碼）' : '') : ''));
    return { text, err, picker, input, wrap, calOpen, calUp, commit, onKey, onInput, openPicker, fromCal, plus, clear, suffix, rel, full };
  },
  template: `<div ref="wrap" style="position:relative">
    <div class="rocd" :class="{err}" :title="full">
      <input ref="input" class="t" data-nav :value="text" @input="onInput" :placeholder="placeholder" :disabled="disabled"
        inputmode="numeric" autocomplete="off" @blur="commit" @keydown="onKey" @focus="$event.target.select()">
      <span class="wk" v-if="suffix">{{suffix}}</span>
      <button type="button" class="x" v-if="modelValue && !disabled" tabindex="-1" title="清除" @click="clear">×</button>
      <button type="button" class="cal" tabindex="-1" title="民國年日曆" :disabled="disabled" @click="openPicker">📅</button>
    </div>
    <RocCalendar v-if="calOpen" :model-value="modelValue" :birth="birth" :up="calUp" @pick="fromCal" @close="calOpen=false" />
    <div class="plus" v-if="prev && !disabled && !compact"><span class="tiny muted">{{ modelValue ? rel : '依前次' }}</span>
      <button type="button" tabindex="-1" @click="plus(28)">+28</button>
      <button type="button" tabindex="-1" @click="plus(30)">+30</button>
    </div>
    <div class="tiny muted" v-else-if="rel">{{rel}}</div>
  </div>`,
};

const FamIcon = { template: `<span class="famic" title="有同行家人">👪</span>` };

// ---------------------------------------------------------------- 下拉選單鍵盤控制
function useList(list, onPick) {
  const idx = ref(0);
  const open = ref(false);
  watch(list, () => { idx.value = 0; });
  function onKey(e) {
    if (!open.value && e.key === 'ArrowDown') { open.value = true; e.preventDefault(); return; }
    if (!open.value || !list.value.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); idx.value = (idx.value + 1) % list.value.length; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); idx.value = (idx.value - 1 + list.value.length) % list.value.length; }
    else if (e.key === 'Enter') { onPick(list.value[idx.value]); open.value = false; }
    else if (e.key === 'Escape') { open.value = false; }
  }
  return { idx, open, onKey };
}
const cleanQ = s => String(s || '').replace(/[,()*%\\]/g, '').trim();

// ---------------------------------------------------------------- 醫院
export const HospitalInput = {
  props: { code: String, name: String },
  emits: ['update:code', 'update:name', 'pick'],
  setup(props, { emit }) {
    const text = ref(props.name || '');
    const remote = ref([]);
    const loading = ref(false);
    watch(() => props.name, v => { if (v !== text.value) text.value = v || ''; });
    const quickHits = computed(() => {
      const s = text.value.trim().toUpperCase();
      const all = state.quick.map(x => ({ quick: x.quick_code, code: x.hospital_code, name: x.name, label: x.label, default_dept: x.default_dept }));
      if (!s || s === (props.name || '').toUpperCase()) return all;
      const exact = all.filter(x => x.quick.toUpperCase() === s);
      const rest = all.filter(x => x.quick.toUpperCase() !== s &&
        (x.quick.toUpperCase().startsWith(s) || x.name.includes(s) || (x.label || '').includes(s) || x.code.startsWith(s)));
      return [...exact, ...rest];
    });
    const list = computed(() => {
      const seen = new Set(quickHits.value.map(x => x.code));
      return [...quickHits.value, ...remote.value.filter(x => !seen.has(x.code))];
    });
    const search = debounce(async s => {
      s = cleanQ(s);
      if (!s || s === props.name || (s.length < 2 && !/^\d{3,}$/.test(s))) { remote.value = []; return; }
      loading.value = true;
      try {
        const rows = await q(sb.from('rx_hospitals').select('code,name,short_name').eq('active', true)
          .or(`code.like.${s}%,name.ilike.%${s}%,short_name.ilike.%${s}%`).limit(30));
        const S = s.toUpperCase();
        rows.sort((a, b) => ((b.code === S) - (a.code === S)) || (b.name.startsWith(s) - a.name.startsWith(s)) || (a.name.length - b.name.length));
        if (cleanQ(text.value) === s) remote.value = rows.slice(0, 20);
      } catch (e) { toastErr(e); } finally { loading.value = false; }
    });
    function pick(h) {
      if (!h) return;
      text.value = h.name;
      emit('update:code', h.code); emit('update:name', h.name); emit('pick', h);
      remote.value = [];
    }
    const L = useList(list, pick);
    function onInput() { L.open.value = true; search(text.value); }
    // 直接打 9～10 碼院所代號：不等搜尋結果，按 Enter 或離開欄位時直接查代號
    const isCode = t => /^[0-9A-Z]{9,10}$/.test(t);
    async function byCode(t) {
      const rows = await q(sb.from('rx_hospitals').select('code,name').eq('code', t).limit(1));
      if (rows[0]) { pick(rows[0]); return true; }
      toast('查無院所代號 ' + t, 'err');
      return false;
    }
    async function onKeyH(e) {
      if (e.key === 'Enter' && !e.isComposing) {
        const t = cleanQ(text.value).toUpperCase();
        const exact = list.value.find(x => x.code === t || (x.quick && x.quick.toUpperCase() === t));
        if (exact) { e.preventDefault(); pick(exact); L.open.value = false; return; }   // 交給表單跳下一欄
        if (isCode(t)) {
          e.preventDefault(); e.stopPropagation();
          const el = e.target;
          if (await byCode(t)) { L.open.value = false; focusNext(el); }
          return;
        }
      }
      L.onKey(e);
    }
    function onBlur() {
      setTimeout(async () => {
        L.open.value = false;
        const t = text.value.trim();
        if (!t) { emit('update:code', ''); emit('update:name', ''); }
        else if (t !== props.name) {
          if (isCode(t.toUpperCase()) && await byCode(t.toUpperCase())) return;
          emit('update:code', ''); emit('update:name', t);                         // 清單外醫院，保留文字
        }
      }, 120);
    }
    return { text, list, loading, pick, onInput, onBlur, ...L, onKey: onKeyH };
  },
  template: `<div style="position:relative">
    <input class="inp" data-nav v-model="text" autocomplete="off" placeholder="快速碼 / 院所代號 / 名稱" :title="name"
      @input="onInput" @click="open=true" @focus="$event.target.select()" @blur="onBlur" @keydown="onKey">
    <div class="dd" v-if="open && (list.length || loading)">
      <div class="sec" v-if="list.length && list[0].quick">常用醫院（輸入快速碼）</div>
      <div v-for="(h,i) in list" :key="h.code + (h.quick||'')" class="it" :class="{on:i===idx}" @mousedown.prevent="pick(h); open=false">
        <span class="src q" v-if="h.quick">{{h.quick}}</span>
        <div class="grow"><div class="t ell">{{h.label || h.name}}</div><div class="d">{{h.code}}<template v-if="h.label"> · {{h.name}}</template></div></div>
      </div>
      <div class="empty" v-if="loading">搜尋中…</div>
    </div>
  </div>`,
};

// ---------------------------------------------------------------- 科別
export const DeptInput = {
  props: { code: String },
  emits: ['update:code', 'update:name'],
  setup(props, { emit }) {
    const cur = () => state.depts.find(d => d.code === props.code);
    const show = d => (d ? `${d.code} ${d.name}` : '');
    const text = ref(show(cur()));
    watch(() => [props.code, state.depts.length], () => { text.value = show(cur()); });
    const list = computed(() => {
      const s = text.value.trim().toUpperCase();
      if (!s || s === show(cur()).toUpperCase()) return state.depts;
      const exact = state.depts.filter(d => d.code.toUpperCase() === s);
      return [...exact, ...state.depts.filter(d => d.code.toUpperCase() !== s && (d.code.toUpperCase().startsWith(s) || d.name.includes(text.value.trim())))];
    });
    function pick(d) { if (!d) return; text.value = show(d); emit('update:code', d.code); emit('update:name', d.name); }
    const L = useList(list, pick);
    function onBlur() {
      setTimeout(() => {
        L.open.value = false;
        if (!text.value.trim()) { emit('update:code', ''); emit('update:name', ''); return; }
        text.value = show(cur());
      }, 120);
    }
    return { text, list, pick, onBlur, ...L };
  },
  template: `<div style="position:relative">
    <input class="inp" data-nav v-model="text" autocomplete="off" placeholder="代碼或名稱，例：02、AB、內科"
      @input="open=true" @click="open=true" @focus="$event.target.select()" @blur="onBlur" @keydown="onKey">
    <div class="dd" v-if="open && list.length">
      <div v-for="(d,i) in list" :key="d.code" class="it" :class="{on:i===idx}" @mousedown.prevent="pick(d); open=false">
        <span class="src q" style="min-width:28px;text-align:center">{{d.code}}</span><div class="grow t">{{d.name}}</div>
      </div>
    </div>
  </div>`,
};

// ---------------------------------------------------------------- 通知方式
export const NotifyPicker = {
  props: { modelValue: { type: Array, default: () => [] }, small: Boolean },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    function toggle(m) {
      const s = new Set(props.modelValue);
      s.has(m) ? s.delete(m) : s.add(m);
      emit('update:modelValue', NOTIFY.filter(x => s.has(x)));
    }
    return { NOTIFY, toggle };
  },
  template: `<div class="toggles" :class="{sm:small}">
    <button type="button" v-for="m in NOTIFY" :key="m" :class="{on:modelValue.includes(m)}" @click="toggle(m)">{{m}}</button>
  </div>`,
};

export const NotifyPills = {
  props: { list: Array },
  setup: () => ({ NOTIFY_CLS }),
  template: `<span style="display:inline-flex;gap:4px;flex-wrap:nowrap"><span v-for="m in list||[]" :key="m" class="pill" :class="NOTIFY_CLS[m]">{{m}}</span></span>`,
};

export const FillChip = {
  props: { f: Object, showStatus: Boolean },
  setup(props) {
    const late = computed(() => props.f.status === 'pending' && props.f.due_date < todayISO());
    return { rocOf, fullOf, FILL_STATUS, late };
  },
  template: `<span class="fc" :class="[f.status, {late}]" :title="'第'+f.seq+'次 '+fullOf(f.due_date)+' '+FILL_STATUS[f.status]">
    <span class="s sq" :class="'sq'+f.seq">{{f.seq}}</span><span class="num" style="font-weight:800">{{rocOf(f.due_date)}}</span>
    <span v-if="showStatus" class="tiny">{{FILL_STATUS[f.status]}}</span></span>`,
};

// ---------------------------------------------------------------- 人員代碼視窗（全域）
export const StaffPrompt = {
  setup() {
    const code = ref('');
    const reason = ref('');
    const inp = ref(null);
    const rinp = ref(null);
    const shake = ref(false);
    const REASONS = computed(() => storeSetting('cancel_reasons', DEFAULT_CANCEL_REASONS) || DEFAULT_CANCEL_REASONS);
    const hit = computed(() => findStaff(code.value));
    watch(() => state.ask, a => {
      if (a) { code.value = ''; reason.value = ''; nextTick(() => (a.reason ? rinp.value : inp.value)?.focus()); }
    });
    function ok() {
      if (state.ask.reason && state.ask.reasonRequired && !reason.value.trim()) { toast('請填寫原因', 'err'); rinp.value?.focus(); return; }
      if (!hit.value) { shake.value = true; setTimeout(() => (shake.value = false), 400); return; }
      const a = state.ask; state.ask = null; a.resolve({ code: hit.value.code, name: hit.value.name, reason: reason.value.trim() });
    }
    function cancel() { const a = state.ask; state.ask = null; a?.resolve(null); }
    return { state, code, reason, inp, rinp, hit, ok, cancel, shake, REASONS };
  },
  template: `<div class="mask" v-if="state.ask" @mousedown.self="cancel">
    <div class="modal" style="width:min(380px,100%)">
      <header><h3><i class="sl"></i>{{state.ask.title}}</h3><button class="x" @click="cancel">取消</button></header>
      <p class="small muted" v-if="state.ask.desc">{{state.ask.desc}}</p>
      <div v-if="state.ask.reason" style="margin-bottom:14px">
        <div class="lbl" style="margin-bottom:6px">原因</div>
        <input ref="rinp" class="inp" v-model="reason" placeholder="輸入原因或點選下方" @keydown.enter.prevent="inp && inp.focus()" @keydown.esc="cancel">
        <div class="chips" style="margin-top:6px"><button type="button" class="chip" v-for="r in REASONS" :key="r" :class="{on:reason===r}" @click="reason=r; inp && inp.focus()">{{r}}</button></div>
        <div class="lbl" style="margin:14px 0 6px">人員代碼</div>
      </div>
      <input ref="inp" class="inp staffcode" :class="{err:shake}" v-model="code" type="password" inputmode="numeric"
        autocomplete="off" @keydown.enter.prevent="ok" @keydown.esc="cancel" placeholder="••••">
      <div class="staffname" style="margin-top:10px">{{ hit ? '👤 ' + hit.name : (code ? '查無此代碼' : '請輸入人員代碼後按 Enter') }}</div>
      <div class="btns" style="justify-content:flex-end;margin-top:12px"><button class="btn fill" :disabled="!hit" @click="ok">確認</button></div>
    </div>
  </div>`,
};

// ---------------------------------------------------------------- 寄單表單（新增 / 修改共用）
function emptyForm() {
  const dc = storeSetting('default_dept_code', '');
  const d = dc && state.depts.find(x => x.code === dc);
  return {
    patient_name: '', birth_date: '', phone: '', notify_methods: [...(storeSetting('default_notify', []) || [])], note: '',
    hospital_code: storeSetting('default_hospital_code', '') || '', hospital_name: storeSetting('default_hospital_name', '') || '',
    dept_code: d ? d.code : '', dept_name: d ? d.name : '', ext_patient_id: '', family_no: '', dates: ['', '', ''],
    _family: null,
  };
}

export const OrderForm = {
  components: { RocDate, HospitalInput, DeptInput, NotifyPicker, FillChip },
  props: { order: Object },                 // 有值 = 修改模式
  emits: ['saved', 'cancel', 'open-order'],
  setup(props, { emit, expose }) {
    const root = ref(null);
    const nameEl = ref(null);
    // 新增模式使用全域暫存（切換頁面不會遺失）；修改模式用各自的表單
    if (!props.order && !state.draft) state.draft = emptyForm();
    const f = props.order ? reactive(emptyForm()) : state.draft;
    const family = computed({ get: () => f._family, set: v => { f._family = v; } });   // 同行家人 { order_no, patient_name }
    const saving = ref(false);
    const errs = reactive({});
    const sugg = ref([]);
    const suggOpen = ref(false);
    const suggIdx = ref(0);
    const openOrders = ref([]);
    const printMode = ref(getPrintMode());
    watch(printMode, setPrintMode);
    const edit = computed(() => !!props.order);
    const fillOf = seq => props.order?.fills?.find(x => x.seq === seq);
    const quickDepts = computed(() => (storeSetting('quick_depts', []) || []).map(c => state.depts.find(d => d.code === c)).filter(Boolean));

    function load(o) {
      Object.assign(f, emptyForm());
      if (!o) return;
      Object.assign(f, {
        patient_name: o.patient_name, birth_date: o.birth_date || '', phone: o.phone || '', notify_methods: [...(o.notify_methods || [])],
        note: o.note || '', hospital_code: o.hospital_code || '', hospital_name: o.hospital_name || '',
        dept_code: o.dept_code || '', dept_name: o.dept_name || '', ext_patient_id: o.ext_patient_id || '', family_no: o.family_no || '',
        dates: [1, 2, 3].map(s => o.fills?.find(x => x.seq === s && x.status !== 'cancelled')?.due_date || ''),
      });
    }
    watch(() => props.order, load);
    if (props.order) load(props.order);

    const phoneReq = computed(() => f.notify_methods.some(m => m === '簡訊' || m === '電話'));
    const onPhone = e => { f.phone = onlyDigits(e.target.value); e.target.value = f.phone; };

    // ---- 姓名自動完成：本系統紀錄 + 藥局系統 ----
    let seqNo = 0;
    const doSuggest = debounce(async s => {
      const my = ++seqNo;
      if (!s) { sugg.value = []; suggOpen.value = false; return; }
      const [hist, ext] = await Promise.all([
        rpc('rx_patient_suggest', { p_store: state.storeId, q: s }).catch(() => []),
        bridgeSearch(s),
      ]);
      if (my !== seqNo) return;
      const key = (n, b, p) => `${n}|${b || ''}|${p || ''}`;
      const histKeys = new Set(hist.map(h => key(h.patient_name, h.birth_date, h.phone)));
      sugg.value = [
        ...hist.map(h => ({ ...h, src: 'h' })),
        ...ext.map(p => ({ src: 'p', patient_name: p.name, phone: onlyDigits(p.phone), birth_date: (p.birthday || '').slice(0, 10), ext_patient_id: p.ext_id || '', last_visit: p.last_visit || '' }))
          .filter(p => !histKeys.has(key(p.patient_name, p.birth_date, p.phone))),
      ].slice(0, 15);
      suggIdx.value = -1;                     // 沒有用方向鍵選擇時，Enter 維持原本輸入的內容
      suggOpen.value = sugg.value.length > 0;
    }, 220);
    const onName = () => { openOrders.value = []; if (!edit.value) doSuggest(f.patient_name.trim()); };
    function pickSugg(s) {
      if (!s) return;
      f.patient_name = s.patient_name;
      if (s.birth_date) f.birth_date = s.birth_date;
      if (s.phone) f.phone = s.phone;
      if (s.ext_patient_id) f.ext_patient_id = s.ext_patient_id;
      if (s.src === 'h') {
        f.notify_methods = [...(s.notify_methods || [])];
        f.hospital_code = s.hospital_code || ''; f.hospital_name = s.hospital_name || '';
        f.dept_code = s.dept_code || ''; f.dept_name = s.dept_name || '';
      }
      suggOpen.value = false;
      checkOpen();
      nextTick(() => {   // 帶入後跳到第一個需要填的欄位
        const sel = [f.notify_methods.length ? null : '[data-k=notify] button', f.hospital_name ? null : '[data-k=hosp] input', '[data-k=d2] input.t'].find(Boolean);
        root.value?.querySelector(sel)?.focus();
      });
    }
    function onNameKey(e) {
      if (!suggOpen.value || !sugg.value.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); suggIdx.value = (suggIdx.value + 1) % sugg.value.length; }
      else if (e.key === 'ArrowUp') { e.preventDefault(); suggIdx.value = suggIdx.value <= 0 ? sugg.value.length - 1 : suggIdx.value - 1; }
      else if (e.key === 'Enter') {
        if (suggIdx.value >= 0) { e.preventDefault(); e.stopPropagation(); pickSugg(sugg.value[suggIdx.value]); }
        else suggOpen.value = false;          // 交給表單跳下一欄
      }
      else if (e.key === 'Escape') suggOpen.value = false;
    }
    const onNameBlur = () => setTimeout(() => { suggOpen.value = false; checkOpen(); }, 150);

    // ---- 同一病人尚未完成的寄單（含醫院、科別，方便回答「某科的藥寄了沒」）----
    async function checkOpen() {
      const n = f.patient_name.trim();
      if (!n) { openOrders.value = []; return; }
      try {
        const rows = await q(sb.from('rx_fill_view')
          .select('order_id,order_no,seq,due_date,fill_status,phone,birth_date,hospital_code,hospital_name,dept_name,created_at')
          .eq('store_id', state.storeId).eq('patient_name', n).in('fill_status', ['pending', 'prepared', 'notified'])
          .gte('due_date', addDays(todayISO(), -14)).order('due_date').limit(30));
        const mine = rows.filter(r => !props.order || r.order_id !== props.order.id)
          .filter(r => birthMatch(f.birth_date, r.birth_date))
          .filter(r => f.birth_date || !f.phone || !r.phone || r.phone === f.phone);
        const by = {};
        for (const r of mine) {
          (by[r.order_id] ||= { order_id: r.order_id, order_no: r.order_no, birth_date: r.birth_date, hosp: shortHosp(r.hospital_code, r.hospital_name), dept: r.dept_name, fills: [] })
            .fills.push({ seq: r.seq, due_date: r.due_date, status: r.fill_status });
        }
        openOrders.value = Object.values(by);
      } catch { openOrders.value = []; }
    }
    const sameNameOther = computed(() => !f.birth_date && new Set(openOrders.value.map(o => o.birth_date).filter(Boolean)).size > 1);
    // 儲存按鈕間用 ←→ 切換
    function onBtnKey(e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const bs = [...root.value.querySelectorAll('.savebar .btn:not(:disabled)')];
      const i = bs.indexOf(e.target);
      bs[(i + (e.key === 'ArrowRight' ? 1 : -1) + bs.length) % bs.length]?.focus();
    }

    // ---- 片語 ----
    const hasPhrase = t => f.note.split(/[、，,\s]+/).includes(t);
    function togglePhrase(t) {
      if (hasPhrase(t)) f.note = f.note.split('、').filter(x => x.trim() !== t).join('、');
      else f.note = f.note.trim() ? f.note.trim().replace(/[、，,]$/, '') + '、' + t : t;
    }
    function onHospPick(h) {
      if (h.default_dept && (!f.dept_code || f.dept_code === storeSetting('default_dept_code', ''))) {
        const d = state.depts.find(x => x.code === h.default_dept);
        if (d) { f.dept_code = d.code; f.dept_name = d.name; }
      }
    }
    function pickQuick(x) { f.hospital_code = x.hospital_code; f.hospital_name = x.name; onHospPick(x); }
    function pickDept(d) { f.dept_code = d.code; f.dept_name = d.name; }

    // ---- Enter 跳下一欄（日期最後一欄 → 備註）----
    function onFormKey(e) {
      if (e.key !== 'Enter' || e.isComposing || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'BUTTON') return;
      const items = [...root.value.querySelectorAll('[data-nav]')].filter(el => !el.disabled);
      const i = items.indexOf(e.target);
      if (i >= 0) { e.preventDefault(); setTimeout(() => items[i + 1]?.focus(), 0); }
    }

    function validate() {
      for (const k of Object.keys(errs)) delete errs[k];
      if (!f.patient_name.trim()) errs.name = '請輸入姓名';
      if (!f.notify_methods.length) errs.notify = '請選擇通知方式';
      if (phoneReq.value && !f.phone) errs.phone = '簡訊／電話通知需填電話';
      if (f.phone && f.phone.length < 8) errs.phone = '電話位數不足';
      if (f.birth_date && f.birth_date > todayISO()) errs.birth = '生日不能晚於今天';
      if (!f.dates.some(Boolean)) errs.dates = '請至少輸入一次領藥日期';
      const d = f.dates.filter(Boolean);
      for (let i = 1; i < d.length; i++) if (d[i] < d[i - 1]) errs.dates = '後一次的日期早於前一次，請確認';
      const k = Object.keys(errs);
      if (k.length) { toast(errs[k[0]], 'err'); return false; }
      return true;
    }
    function payload() {
      return {
        store_id: state.storeId, patient_name: f.patient_name.trim(), birth_date: f.birth_date, phone: f.phone,
        notify_methods: f.notify_methods, note: f.note.trim(), hospital_code: f.hospital_code, hospital_name: f.hospital_name,
        dept_code: f.dept_code, dept_name: f.dept_name, ext_patient_id: f.ext_patient_id,
        family_no: edit.value ? f.family_no : (family.value?.order_no || ''),
        fills: f.dates.map((d, i) => ({ seq: i + 1, due_date: d })).filter(x => x.due_date),
      };
    }

    const snap = () => JSON.stringify(payload());
    let orig = '';
    watch(() => props.order, () => nextTick(() => { orig = edit.value ? snap() : ''; }), { immediate: true });
    async function save(print = false) {
      if (saving.value || !validate()) return;
      if (edit.value && snap() === orig) { toast('沒有修改', 'info', 1400); emit('cancel'); return; }
      // 領藥日早於或等於「最新預作日」→ 提醒直接打單調劑
      let lastPrep = '';
      try { lastPrep = (await q(sb.from('rx_stores').select('settings').eq('id', state.storeId).single())).settings?.last_prep_date || ''; } catch { /* ignore */ }
      if (lastPrep) {
        const hits = f.dates.map((d, i) => ({ seq: i + 1, d })).filter(x => x.d && x.d <= lastPrep)
          .filter(x => !edit.value || !fillOf(x.seq) || (fillOf(x.seq).status === 'pending' && fillOf(x.seq).due_date !== x.d));
        if (hits.length) {
          const ok = await askConfirm({
            title: '⚠ 已過目前最新預作日期', danger: true,
            msg: `${hits.map(x => `第${x.seq}次領藥日 ${fullOf(x.d)}`).join('、')}，早於或等於目前最新預作日 ${fullOf(lastPrep)}。`,
            strong: '請直接打單調劑，勿歸入預作資料夾！',
            okText: '我知道了，繼續儲存', cancelText: '返回修改',
          });
          if (!ok) return;
        }
      }
      const staff = await askStaff(edit.value ? '修改寄單' : (print ? '儲存並列印' : '儲存寄單'), '請輸入人員代碼確認');
      if (!staff) return;
      saving.value = true;
      try {
        const p = payload();
        const res = edit.value
          ? await rpc('rx_update_order', { p_id: props.order.id, p, p_staff: staff.code })
          : await rpc('rx_create_order', { p, p_staff: staff.code });
        if (print) {
          printOrder({ ...p, id: res.id, order_no: res.order_no, created_at: new Date().toISOString(), created_staff_name: staff.name },
            p.fills.map(x => ({ ...x, status: 'pending' })), printMode.value);
        }
        toast(`${edit.value ? '已更新' : '已寄單'}　${fmtNo(res.order_no)}　${p.patient_name}`, 'ok', 3500);
        bump();
        emit('saved', { ...res, print, payload: p, family_no: p.family_no || res.order_no });
        if (!edit.value) reset();
      } catch (e) { toastErr(e); } finally { saving.value = false; }
    }
    function reset() {
      load(null); openOrders.value = []; sugg.value = [];
      for (const k of Object.keys(errs)) delete errs[k];
      nextTick(() => nameEl.value?.focus());
    }
    /** 寄同行家人：帶入電話、通知方式，並連結到第一位家人 */
    function startFamily(prev) {
      reset();
      family.value = { order_no: prev.family_no, patient_name: prev.payload.patient_name };
      f.phone = prev.payload.phone || '';
      f.notify_methods = [...prev.payload.notify_methods];
    }
    expose({ startFamily, reset });

    function onHotkey(e) {
      if (state.ask || (!edit.value && state.detailId)) return;
      const k = e.key.toLowerCase();
      // F1 儲存並列印、F2 儲存、F3 清除（Ctrl+S 也可儲存）
      if (e.key === 'F2' || ((e.ctrlKey || e.metaKey) && k === 's')) { e.preventDefault(); save(false); }
      else if (!edit.value && e.key === 'F1') { e.preventDefault(); save(true); }
      else if (!edit.value && e.key === 'F3') { e.preventDefault(); reset(); }
    }
    onMounted(() => {
      window.addEventListener('keydown', onHotkey);
      if (!edit.value) { nameEl.value?.focus(); if (f.patient_name) checkOpen(); }
    });
    onBeforeUnmount(() => window.removeEventListener('keydown', onHotkey));

    return {
      state, root, nameEl, f, family, errs, saving, sugg, suggOpen, suggIdx, openOrders, sameNameOther, edit, printMode, PRINT_MODES,
      phoneReq, quickDepts, fillOf, onBtnKey, NOTIFY_CLS, onPhone, onName, pickSugg, onNameKey, onNameBlur, hasPhrase, togglePhrase, onHospPick, pickQuick,
      pickDept, onFormKey, save, reset, checkOpen, FILL_STATUS, fmtNo, dayOf, rocOf, shortHosp, birthOf, ageOf, fullOf, emit,
    };
  },
  template: `<div ref="root" @keydown="onFormKey" class="oform">
    <div class="form">
      <div class="fld c4">
        <label>姓名 <span class="req">*</span></label>
        <div style="position:relative">
          <input ref="nameEl" class="inp big" :class="{err:errs.name}" data-nav v-model="f.patient_name" autocomplete="off"
            placeholder="姓名或電話，帶出過往紀錄" @input="onName" @keydown="onNameKey" @blur="onNameBlur"
            @focus="sugg.length && (suggOpen = true)">
          <div class="dd sugg" v-if="suggOpen">
            <div v-for="(s,i) in sugg" :key="i" class="it" :class="{on:i===suggIdx}" @mousedown.prevent="pickSugg(s)">
              <span class="src" :class="s.src">{{ s.src==='h' ? '紀錄' : '藥局' }}</span>
              <div class="grow">
                <div class="l1"><b>{{s.patient_name}}</b>
                  <span v-if="s.birth_date" class="num">{{fullOf(s.birth_date)}}</span>
                  <span class="num muted">{{s.phone}}</span>
                  <span v-for="m in s.notify_methods||[]" :key="m" class="pill" :class="NOTIFY_CLS[m]">{{m}}</span></div>
                <div class="d" v-if="s.src==='h'">
                  <b v-if="s.open_fills" class="warn">未完成 {{s.open_fills}}</b>
                  {{shortHosp(s.hospital_code, s.hospital_name) || '—'}}｜{{s.dept_name || '—'}}｜上次 {{dayOf(s.created_at)}}</div>
                <div class="d" v-else>{{s.ext_patient_id ? '病歷 ' + s.ext_patient_id : ''}} {{s.last_visit ? '｜最近就診 ' + s.last_visit : ''}}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="fld c3">
        <label>生日</label>
        <RocDate v-model="f.birth_date" birth placeholder="0750312 或 75/**/12" />
      </div>
      <div class="fld c5">
        <label>電話 <span class="req" v-if="phoneReq">*</span><span class="opt" v-else>LINE／自取可不填</span></label>
        <input class="inp big num" :class="{err:errs.phone}" data-nav :value="f.phone" @input="onPhone" @blur="checkOpen"
          inputmode="numeric" maxlength="10" autocomplete="off" placeholder="09xxxxxxxx">
      </div>

      <div class="fld c12" v-if="family">
        <div class="alert ok">與 <b>{{family.patient_name}}</b>（{{fmtNo(family.order_no)}}）同行，預作完成後會一起通知
          <button class="linkbtn" style="margin-left:8px" @click="family=null">取消同行</button></div>
      </div>
      <div class="fld c12" v-if="openOrders.length">
        <div class="alert">
          <div>⚠️ <b>{{f.patient_name}}</b> 目前有 {{openOrders.length}} 筆未完成寄單
            <span v-if="sameNameOther" class="small">（有同名不同生日，請輸入生日區分）</span></div>
          <table class="oo">
            <tr v-for="o in openOrders" :key="o.order_id" @click="emit('open-order', o.order_id)">
              <td class="num">{{fmtNo(o.order_no)}}</td>
              <td v-if="sameNameOther" class="num small">{{fullOf(o.birth_date)}}</td>
              <td class="hp"><b>{{o.hosp || '—'}}</b></td>
              <td><b>{{o.dept || '—'}}</b></td>
              <td><span v-for="x in o.fills" :key="x.seq" class="fc" :class="x.status" style="margin-right:4px">
                <span class="s sq" :class="'sq'+x.seq">{{x.seq}}</span><span class="num">{{rocOf(x.due_date)}}</span><span class="tiny">{{FILL_STATUS[x.status]}}</span></span></td>
            </tr>
          </table>
        </div>
      </div>

      <div class="fld c12" data-k="notify">
        <label>通知方式 <span class="req">*</span><span class="opt">可複選</span></label>
        <NotifyPicker v-model="f.notify_methods" />
        <div class="hint err" v-if="errs.notify">{{errs.notify}}</div>
      </div>

      <div class="fld c7" data-k="hosp">
        <label>醫院 <span class="opt" v-if="f.hospital_code">{{f.hospital_code}}</span>
          <span class="opt" style="color:var(--orange-ink)" v-else-if="f.hospital_name">清單外醫院</span></label>
        <HospitalInput v-model:code="f.hospital_code" v-model:name="f.hospital_name" @pick="onHospPick" />
      </div>
      <div class="fld c5">
        <label>科別</label>
        <DeptInput v-model:code="f.dept_code" v-model:name="f.dept_name" />
      </div>
      <div class="fld c7" v-if="state.quick.length">
        <div class="tiles">
          <button type="button" tabindex="-1" class="tile" v-for="x in state.quick" :key="x.quick_code"
            :class="{on: f.hospital_code===x.hospital_code}" :title="x.name" @click="pickQuick(x)">
            <span class="k">{{x.quick_code}}</span><span class="ell">{{x.label || shortHosp(x.hospital_code, x.name)}}</span></button>
        </div>
      </div>
      <div class="fld c5" v-if="quickDepts.length">
        <div class="tiles d">
          <button type="button" tabindex="-1" class="tile" v-for="d in quickDepts" :key="d.code"
            :class="{on: f.dept_code===d.code}" :title="d.name" @click="pickDept(d)">
            <span class="k">{{d.code}}</span><span class="ell">{{d.name}}</span></button>
        </div>
      </div>

      <div class="fld c4" v-for="i in 3" :key="i" :data-k="'d'+i">
        <label :class="'lq'+i">第{{['一','二','三'][i-1]}}次領藥
          <span class="pill" v-if="edit && fillOf(i)" :class="fillOf(i).status">{{FILL_STATUS[fillOf(i).status]}}</span></label>
        <RocDate v-model="f.dates[i-1]" :prev="i>1 ? f.dates[i-2] : ''" :disabled="edit && ['notified','picked'].includes(fillOf(i)?.status)" />
      </div>
      <div class="fld c12" v-if="errs.dates"><div class="hint err">{{errs.dates}}</div></div>

      <div class="fld c12">
        <label>備註</label>
        <input class="inp" data-nav v-model="f.note" autocomplete="off" :placeholder="edit ? '可直接輸入，或點下方常用片語' : '可直接輸入，或點下方常用片語；Enter 跳到「儲存並列印」'">
        <div class="chips" v-if="state.phrases.length">
          <button type="button" tabindex="-1" class="chip" v-for="p in state.phrases" :key="p.id" :class="{on:hasPhrase(p.text)}"
            @click="togglePhrase(p.text)">{{p.text}}</button>
        </div>
      </div>
    </div>

    <div class="btns savebar" style="margin-top:18px;border-top:1px dashed var(--line);padding-top:16px" @keydown="onBtnKey">
      <template v-if="!edit">
        <button class="btn ghost" type="button" @click="reset">清除 <kbd>F3</kbd></button>
        <span style="flex:1"></span>
        <select class="inp" style="width:auto" v-model="printMode" title="本機列印格式">
          <option v-for="m in PRINT_MODES" :key="m.id" :value="m.id">{{m.name}}</option></select>
        <button class="btn" type="button" :disabled="saving" @click="save(false)">儲存 <kbd>F2</kbd></button>
        <button class="btn fill lg" type="button" data-nav :disabled="saving" @click="save(true)"><i class="sl"></i>儲存並列印 <kbd>F1</kbd></button>
      </template>
      <template v-else>
        <button class="btn ghost" type="button" @click="emit('cancel')">取消</button>
        <span style="flex:1"></span>
        <button class="btn fill" type="button" data-nav :disabled="saving" @click="save(false)">儲存修改 <kbd>F2</kbd></button>
      </template>
    </div>
  </div>`,
};

// ---------------------------------------------------------------- 寄單明細抽屜（全域）
export const OrderDetail = {
  components: { OrderForm, NotifyPills, FillChip, FamIcon },
  setup() {
    const o = ref(null);
    const logs = ref([]);
    const fam = ref([]);
    const editing = ref(false);
    const wide = ref(false);
    const busy = ref(false);
    async function load() {
      const id = state.detailId;
      if (!id) { o.value = null; return; }
      try {
        const [order, fills, lg] = await Promise.all([
          q(sb.from('rx_orders').select('*').eq('id', id).single()),
          q(sb.from('rx_fills').select('*').eq('order_id', id).order('seq')),
          q(sb.from('rx_logs').select('*').eq('order_id', id).order('created_at', { ascending: false })),
        ]);
        o.value = { ...order, fills };
        logs.value = lg;
        fam.value = order.family_no
          ? (await q(sb.from('rx_orders').select('*, fills:rx_fills(*)').eq('family_no', order.family_no))).filter(x => x.id !== id)
          : [];
        linking.value = false; linkQ.value = ''; linkRows.value = [];
      } catch (e) { toastErr(e); close(); }
    }
    watch(() => state.detailId, () => { editing.value = false; load(); });
    watch(() => state.tick, () => { if (state.detailId && !editing.value) load(); });
    function close() { state.detailId = null; }
    async function act(fill, action, extra = {}) {
      const label = ACTION_LABEL[action];
      const s = await askStaff(`第${fill.seq}次：${label}`, '', { reason: action === 'cancel' });
      if (!s) return;
      if (action === 'cancel') extra = { ...extra, reason: s.reason };
      busy.value = true;
      try { await rpc('rx_fill_action', { p_fill_id: fill.id, p_action: action, p_staff: s.code, p_extra: extra }); toast(`第${fill.seq}次 ${label}`, 'ok'); bump(); }
      catch (e) { toastErr(e); } finally { busy.value = false; }
    }
    async function cancelOrder() {
      const s = await askStaff('取消整張寄單', '尚未通知的各次領藥都會一併取消。', { reason: true });
      if (!s) return;
      try { await rpc('rx_cancel_order', { p_id: o.value.id, p_staff: s.code, p_reason: s.reason }); toast('寄單已取消', 'warn'); bump(); }
      catch (e) { toastErr(e); }
    }
    function reprint(mode) { printOrder(o.value, o.value.fills, mode); setTimeout(bump, 800); }
    const firstVia = () => (o.value?.notify_methods || []).find(m => m !== '自取') || '自取';
    const msg = f => fillTpl(storeSetting('notify_template', ''), o.value, f);
    const self = computed(() => selfOnly(o.value?.notify_methods));
    function logText(l) {
      const d = l.detail || {};
      if (l.action === 'create') return d.family_no ? '同行家人 ' + fmtNo(d.family_no) : '';
      if (l.action === 'edit') {
        const b = d.before || {}, a = d.after || {}, out = [];
        const keys = { patient_name: '姓名', birth_date: '生日', phone: '電話', note: '備註', hospital_name: '醫院', dept_name: '科別' };
        for (const k in keys) if ((b[k] || '') !== (a[k] || '')) out.push(`${keys[k]}：${b[k] || '—'} → ${a[k] || '—'}`);
        if (JSON.stringify(b.notify_methods) !== JSON.stringify(a.notify_methods)) out.push(`通知：${(b.notify_methods || []).join('、')} → ${(a.notify_methods || []).join('、')}`);
        const fd = x => (x || []).map(f => `${f.seq}:${rocOf(f.due_date)}`).join(' ');
        if (fd(b.fills) !== fd(a.fills)) out.push(`日期：${fd(b.fills)} → ${fd(a.fills)}`);
        return out.join('；');
      }
      if (l.action === 'family') return d.with_name ? `與 ${d.with_name}（${fmtNo(d.with)}）` : '';
      if (l.action === 'print') return PRINT_MODES.find(m => m.id === d.mode)?.name || '';
      const s = d.seq ? `領藥日 ${rocOf(d.due_date)}` : '';
      return [s, d.via ? '透過 ' + d.via : '', d.via_scan ? '刷條碼' : '', d.force_date ? '日期不符仍確認' : '', d.reason ? '原因：' + d.reason : '']
        .filter(Boolean).join('　');
    }
    const open = id => { state.detailId = id; };

    // ---- 事後連結同行家人 ----
    const linking = ref(false);
    const linkQ = ref('');
    const linkRows = ref([]);
    async function findLink() {
      const w = cleanQ(linkQ.value);
      try {
        let b = sb.from('rx_orders').select('*, fills:rx_fills(*)').eq('store_id', o.value.store_id).neq('status', 'cancelled').neq('id', o.value.id);
        if (w) b = b.or(`patient_name.ilike.%${w}%,phone.like.${w}%,order_no.like.${w.replace(/-/g, '')}%`);
        else if (o.value.phone) b = b.eq('phone', o.value.phone);         // 預設列出同電話的寄單（家人常共用電話）
        else { linkRows.value = []; return; }
        const rows = await q(b.order('created_at', { ascending: false }).limit(20));
        linkRows.value = rows.filter(r => !o.value.family_no || r.family_no !== o.value.family_no);
      } catch (e) { toastErr(e); }
    }
    const findLinkD = debounce(findLink, 250);
    function startLink() { linking.value = true; linkQ.value = ''; findLink(); }
    async function linkTo(r) {
      const s = await askStaff(`連結 ${o.value.patient_name} ＋ ${r.patient_name} 為同行家人`);
      if (!s) return;
      try { await rpc('rx_link_family', { p_order: o.value.id, p_target: r.id, p_staff: s.code }); toast('已連結同行家人', 'ok'); bump(); }
      catch (e) { toastErr(e); }
    }
    async function unlink() {
      if (!confirm(`將 ${o.value.patient_name} 從同行家人中移除？`)) return;
      const s = await askStaff('解除同行家人'); if (!s) return;
      try { await rpc('rx_unlink_family', { p_order: o.value.id, p_staff: s.code }); toast('已解除同行', 'ok'); bump(); }
      catch (e) { toastErr(e); }
    }
    const sortedFills = x => (x.fills || []).filter(f => f.status !== 'cancelled').sort((a, b) => a.seq - b.seq);

    return { state, o, logs, fam, editing, wide, busy, self, close, act, cancelOrder, reprint, firstVia, msg, copyText, logText, open,
      linking, linkQ, linkRows, findLinkD, startLink, linkTo, unlink, sortedFills, FillChip,
      FILL_STATUS, ORDER_STATUS, ACTION_LABEL, PRINT_MODES, fmtNo, dtOf, rocOf, fullOf, weekOf, diffDays, todayISO, shortHosp, birthOf };
  },
  template: `<template v-if="state.detailId">
    <div class="drawer-mask" @click="close"></div>
    <aside class="drawer" v-if="o" :class="{wide: wide || editing}">
      <header>
        <h3><i class="sl"></i><span class="num">{{fmtNo(o.order_no)}}</span></h3>
        <span class="pill os" :class="'os-'+o.status">{{ORDER_STATUS[o.status]}}</span>
        <span style="flex:1"></span>
        <button class="btn sm" v-if="o.status!=='cancelled' && !editing" @click="editing=true">✎ 修改</button>
        <button class="btn sm ghost" v-if="!editing" :title="wide ? '收合' : '展開'" @click="wide=!wide">{{ wide ? '⇥ 收合' : '⇤ 展開' }}</button>
        <button class="x" @click="close">關閉 Esc</button>
      </header>

      <template v-if="editing">
        <OrderForm :order="o" @saved="editing=false" @cancel="editing=false" />
      </template>
      <template v-else>
        <div class="dhero">
          <div class="row1">
            <span class="nm">{{o.patient_name}}<FamIcon v-if="o.family_no" /></span>
            <span class="bd" v-if="o.birth_date">{{fullOf(o.birth_date)}}</span>
            <span class="hp" :title="o.hospital_name">{{shortHosp(o.hospital_code, o.hospital_name) || '未填醫院'}}</span>
            <span class="dp">{{o.dept_name || '未填科別'}}</span>
          </div>
          <div class="tiny muted" v-if="o.hospital_name">{{o.hospital_name}}　{{o.hospital_code}}</div>
        </div>

        <div class="fillcard" v-for="f in o.fills" :key="f.id" :class="[f.status, 'fq'+f.seq]">
          <div class="no">{{f.seq}}</div>
          <div>
            <div class="dt" :title="'民國 '+fullOf(f.due_date)"><span class="num">{{rocOf(f.due_date)}}</span><small>({{weekOf(f.due_date)}})</small>
              <span class="pill" :class="f.status">{{FILL_STATUS[f.status]}}</span>
              <span class="tiny muted" v-if="f.status==='pending'">{{ diffDays(f.due_date, todayISO())>=0 ? diffDays(f.due_date, todayISO())+'天後' : '已過'+(-diffDays(f.due_date, todayISO()))+'天' }}</span></div>
            <div class="meta">
              <span v-if="f.prepared_at">預作 {{dtOf(f.prepared_at)}} {{f.prepared_by}}　</span>
              <span v-if="f.notified_at">通知 {{dtOf(f.notified_at)}} {{f.notified_by}} {{f.notified_via}}</span>
            </div>
          </div>
          <div class="btns" style="justify-content:flex-end">
            <template v-if="o.status!=='cancelled'">
              <button class="btn xs teal" v-if="f.status==='pending'" :disabled="busy" @click="act(f,'prepare')">預作確認</button>
              <button class="btn xs" v-if="f.status==='prepared'" :disabled="busy" @click="act(f,'unprepare')">取消預作</button>
              <button class="btn xs" v-if="f.status==='prepared' && !self" :disabled="busy" title="複製通知訊息" @click="copyText(msg(f))">複製訊息</button>
              <button class="btn xs fill" v-if="f.status==='prepared' && !self" :disabled="busy" @click="act(f,'notify',{via:firstVia()})">已通知</button>
              <button class="btn xs" v-if="f.status==='notified'" :disabled="busy" @click="act(f,'unnotify')">撤銷通知</button>
              <button class="btn xs danger" v-if="['pending','prepared'].includes(f.status)" :disabled="busy" @click="act(f,'cancel')">取消此次</button>
            </template>
            <button class="btn xs" v-if="f.status==='cancelled'" :disabled="busy" @click="act(f,'restore')">復原</button>
          </div>
        </div>

        <dl class="kv" style="margin-top:16px">
          <dt>電話</dt><dd class="num">{{o.phone || '—'}}</dd>
          <dt>通知</dt><dd><NotifyPills :list="o.notify_methods" /></dd>
          <dt>備註</dt><dd>{{o.note || '—'}}</dd>
          <dt>寄單</dt><dd>{{dtOf(o.created_at)}} · {{o.created_staff_code}} {{o.created_staff_name}}</dd>
          <dt v-if="o.ext_patient_id">藥局病歷</dt><dd v-if="o.ext_patient_id">{{o.ext_patient_id}}</dd>
        </dl>

        <div class="famblock">
          <div class="btns" style="margin-bottom:6px"><b>👪 同行家人</b><span style="flex:1"></span>
            <button class="btn xs" v-if="o.status!=='cancelled' && !linking" @click="startLink">＋連結同行家人</button>
            <button class="btn xs danger" v-if="o.family_no" @click="unlink">解除本筆同行</button></div>
          <div class="fam" v-for="x in fam" :key="x.id" @click="open(x.id)">
            <b>{{x.patient_name}}</b>
            <span class="small">{{shortHosp(x.hospital_code, x.hospital_name) || '—'}}｜{{x.dept_name || '—'}}</span>
            <span style="display:flex;gap:4px"><FillChip v-for="f in sortedFills(x)" :key="f.id" :f="f" show-status /></span>
          </div>
          <div class="small muted" v-if="!fam.length && !linking">尚未連結。家人分開寄單或當下沒有一起打，可在這裡事後連結。</div>
          <div v-if="linking" class="linkbox">
            <div class="inline"><input class="inp" v-model="linkQ" @input="findLinkD" placeholder="搜尋家人姓名／電話／寄單編號（預設列出同電話）">
              <button class="x" @click="linking=false">取消</button></div>
            <div class="fam pick" v-for="r in linkRows" :key="r.id" @click="linkTo(r)">
              <b>{{r.patient_name}}</b><span class="num small muted">{{r.phone}}</span>
              <span class="small">{{shortHosp(r.hospital_code, r.hospital_name) || '—'}}｜{{r.dept_name || '—'}}</span>
              <span style="display:flex;gap:4px"><FillChip v-for="f in sortedFills(r)" :key="f.id" :f="f" /></span>
              <span class="tiny" v-if="r.family_no" style="color:var(--orange-ink)">已有同行群組，會合併</span>
            </div>
            <div class="small muted" v-if="!linkRows.length" style="padding:6px 2px">{{ linkQ ? '找不到符合的寄單' : '沒有同電話的寄單，請輸入姓名搜尋' }}</div>
          </div>
        </div>

        <div class="dfoot">
          <div class="btns">
            <button class="btn sm" v-for="m in PRINT_MODES" :key="m.id" @click="reprint(m.id)">補印{{m.short}}</button>
            <button class="btn sm danger" v-if="o.status==='active'" @click="cancelOrder">取消寄單</button>
          </div>
          <h4 style="margin:16px 0 8px">處理軌跡</h4>
          <div class="tl">
            <div class="tlh"><span>時間</span><span>人員</span><span>動作</span><span>說明</span></div>
            <div class="tlr" v-for="l in logs" :key="l.id" :class="'a-'+l.action">
              <span class="when">{{dtOf(l.created_at)}}</span>
              <span class="who">{{l.staff_name ? (l.staff_code + ' ' + l.staff_name) : '—'}}</span>
              <span class="act"><i class="dot"></i><span v-if="l.detail && l.detail.seq" class="sq" :class="'sq'+l.detail.seq">{{l.detail.seq}}</span>{{ACTION_LABEL[l.action] || l.action}}</span>
              <span class="diff">{{logText(l)}}</span>
            </div>
          </div>
        </div>
      </template>
    </aside>
  </template>`,
};

// ---------------------------------------------------------------- 確認視窗（全域）
export const ConfirmModal = {
  setup() {
    const okBtn = ref(null);
    watch(() => state.confirm, c => { if (c) nextTick(() => okBtn.value?.focus()); });
    function done(v) { const c = state.confirm; state.confirm = null; c?.resolve(v); }
    return { state, okBtn, done };
  },
  template: `<div class="mask" v-if="state.confirm" style="z-index:65" @mousedown.self="done(false)">
    <div class="modal cfm" :class="{danger: state.confirm.danger}" @keydown.esc="done(false)">
      <h3>{{state.confirm.title}}</h3>
      <p v-if="state.confirm.msg">{{state.confirm.msg}}</p>
      <p v-if="state.confirm.strong" class="strong">{{state.confirm.strong}}</p>
      <div class="btns" style="justify-content:flex-end;margin-top:16px">
        <button class="btn ghost" @click="done(false)">{{state.confirm.cancelText}}</button>
        <button ref="okBtn" class="btn" :class="state.confirm.danger ? 'danger-fill' : 'fill'" @click="done(true)">{{state.confirm.okText}}</button>
      </div>
    </div>
  </div>`,
};

// ---------------------------------------------------------------- 通知範本：點標籤插入
export const TplInput = {
  props: { modelValue: String, placeholder: String },
  emits: ['update:modelValue'],
  setup(props, { emit }) {
    const ta = ref(null);
    const TAGS = [['{name}', '姓名'], ['{store}', '門市'], ['{seq}', '第幾次'], ['{date}', '領藥日'], ['{order_no}', '寄單編號']];
    function ins(tok) {
      const el = ta.value, v = props.modelValue || '';
      const a = el ? el.selectionStart ?? v.length : v.length, b = el ? el.selectionEnd ?? v.length : v.length;
      emit('update:modelValue', v.slice(0, a) + tok + v.slice(b));
      nextTick(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = a + tok.length; } });
    }
    const preview = computed(() => fillTpl(props.modelValue || props.placeholder || '', { patient_name: '王小明、李小美', order_no: '26111300013' }, { seq: 2, due_date: addDays(todayISO(), 7) }));
    return { ta, TAGS, ins, preview, emit };
  },
  template: `<div>
    <textarea ref="ta" class="inp" rows="3" :value="modelValue" :placeholder="placeholder" @input="emit('update:modelValue', $event.target.value)"></textarea>
    <div class="chips" style="margin-top:6px"><span class="tiny muted" style="align-self:center">點選插入：</span>
      <button type="button" class="chip" v-for="t in TAGS" :key="t[0]" @click="ins(t[0])">＋{{t[1]}}</button></div>
    <div class="tplprev"><span class="tiny muted">預覽</span>{{preview}}</div>
  </div>`,
};

// ---------------------------------------------------------------- 可編輯表格（管理頁用）
export const CrudTable = {
  props: {
    table: String, pk: { type: Array, default: () => ['id'] }, cols: Array, query: Function,
    defaults: { type: Function, default: () => ({}) }, canAdd: { type: Boolean, default: true },
    canDelete: { type: Boolean, default: true }, reloadKey: [String, Number], hint: String,
  },
  setup(props) {
    const rows = ref([]);
    const loading = ref(false);
    async function load() {
      loading.value = true;
      try {
        let b = sb.from(props.table).select('*');
        if (props.query) b = props.query(b);
        const data = await q(b);
        rows.value = data.map(r => ({ ...r, _o: JSON.stringify(r), _new: false }));
      } catch (e) { toastErr(e); } finally { loading.value = false; }
    }
    watch(() => props.reloadKey, load);
    onMounted(load);
    const clean = r => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_') && (props.cols.some(c => c.key === k) || props.pk.includes(k))));
    const dirty = r => r._new || JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')))) !== r._o;
    function add() { rows.value.unshift({ ...props.defaults(), _new: true, _o: '' }); }
    async function save(r) {
      try {
        const data = clean(r);
        for (const c of props.cols) if (c.type === 'number' && data[c.key] !== undefined && data[c.key] !== '') data[c.key] = Number(data[c.key]);
        for (const c of props.cols) if (c.nullable && data[c.key] === '') data[c.key] = null;
        if (r._new) {
          if (props.pk.includes('id') && data.id === undefined) delete data.id;
          await q(sb.from(props.table).insert(data));
        } else {
          let b = sb.from(props.table).update(data);
          for (const k of props.pk) b = b.eq(k, JSON.parse(r._o)[k]);
          await q(b);
        }
        toast('已儲存', 'ok', 1400);
        await load();
      } catch (e) { toastErr(e); }
    }
    async function del(r) {
      if (r._new) { rows.value = rows.value.filter(x => x !== r); return; }
      if (!confirm('確定刪除這一筆？')) return;
      try {
        let b = sb.from(props.table).delete();
        for (const k of props.pk) b = b.eq(k, r[k]);
        await q(b); toast('已刪除', 'ok', 1400); await load();
      } catch (e) { toastErr(e); }
    }
    return { rows, loading, add, save, del, dirty, load };
  },
  template: `<div>
    <div class="btns" style="margin-bottom:8px">
      <button class="btn sm" v-if="canAdd" @click="add">＋ 新增</button>
      <span class="small muted" v-if="hint">{{hint}}</span>
      <span class="small muted" v-if="loading">載入中…</span>
    </div>
    <div class="tbl"><table class="rowedit">
      <thead><tr><th v-for="c in cols" :key="c.key" :style="{width:c.w}">{{c.label}}</th><th style="width:130px"></th></tr></thead>
      <tbody>
        <tr v-for="(r,i) in rows" :key="i" style="cursor:default" :class="{sel: dirty(r)}">
          <td v-for="c in cols" :key="c.key">
            <input v-if="c.type==='bool'" type="checkbox" v-model="r[c.key]">
            <select v-else-if="c.type==='select'" class="inp" v-model="r[c.key]" :disabled="c.pkLock && !r._new">
              <option v-for="o in (typeof c.options==='function' ? c.options() : c.options)" :key="o.v" :value="o.v">{{o.t}}</option></select>
            <span v-else-if="c.readonly" class="small">{{r[c.key]}}</span>
            <input v-else class="inp" v-model="r[c.key]" :type="c.type==='number'?'number':'text'" :disabled="c.pkLock && !r._new" :placeholder="c.ph||''">
          </td>
          <td class="nw"><button class="btn xs fill" :disabled="!dirty(r)" @click="save(r)">儲存</button>
            <button class="btn xs danger" v-if="canDelete" @click="del(r)">刪除</button></td>
        </tr>
        <tr class="empty-row" v-if="!rows.length && !loading"><td :colspan="cols.length+1">沒有資料</td></tr>
      </tbody>
    </table></div>
  </div>`,
};

export { FamIcon };
