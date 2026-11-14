// supabase/functions/rx-admin-users/index.ts
//
// 部署： npx supabase functions deploy rx-admin-users --remote=<專案代碼> --use-api
//        （單一檔案；也可以在 Supabase 後台 Edge Functions 直接貼上）
// 呼叫： supabase.functions.invoke('rx-admin-users', { body: {...} })
//
// 處方寄單系統的帳號管理（做法與調撥系統 admin-users 相同）。
// 用 service role key 執行，才能呼叫 supabase.auth.admin.* 新增使用者 / 改密碼 / 停權。
//
// 安全性：
//  - 一律先驗證呼叫者的 JWT（auth.getUser），並確認 rx_users.role === 'admin' 且帳號啟用中
//  - 所有輸入都經過驗證（帳號格式、角色白名單、門市代碼、密碼長度）
//  - CORS 只允許公司網站（*.linyaomedical.com）與本機開發；其他網址可在
//    Edge Function Secrets 設定 ALLOWED_ORIGINS（逗號分隔），例如 Railway 預設網址
//  - 管理員不能停用自己、也不能取消自己的管理員身分（避免把自己鎖在外面）
//  - 每次操作都在 Function Logs 留下稽核紀錄（不含密碼）
//  - 只能管理寄單系統的帳號（@rx.linyao.local），不會動到同專案其他系統的使用者

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

// 帳號 → 登入信箱（需與前端 web/js/config.js 的 EMAIL_DOMAIN、SQL 觸發器一致）
const AUTH_EMAIL_DOMAIN = 'rx.linyao.local';
const toAuthEmail = (account: string) => `${String(account).trim().toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;

// ---------- 輸入驗證 ----------
const MAX_PASSWORD_BYTES = 72; // bcrypt 只比對前 72 bytes
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_RE = /^[A-Za-z0-9._-]{2,40}$/;
const STORE_RE = /^[0-9A-Za-z]{1,10}$/;

/** 長度下限由 Supabase 後台 Authentication → Password 決定（最少 6 碼） */
function checkPassword(p: unknown): string {
  if (typeof p !== 'string' || p.length === 0) return '請輸入密碼';
  if (new TextEncoder().encode(p).length > MAX_PASSWORD_BYTES) return '密碼過長，請縮短一些';
  return '';
}
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const checkAccount = (v: unknown) =>
  typeof v === 'string' && ACCOUNT_RE.test(v.trim()) ? '' : '帳號只能使用英文、數字與 . _ -，長度 2～40 個字元';
const checkName = (v: unknown) =>
  v === undefined || v === null || v === '' || (typeof v === 'string' && v.trim().length <= 50) ? '' : '顯示名稱最多 50 個字元';
const checkRole = (v: unknown) => (v === 'admin' || v === 'store' ? '' : '角色只能是管理員或門市');
const checkStore = (v: unknown) =>
  v === undefined || v === null || v === '' || (typeof v === 'string' && STORE_RE.test(v)) ? '' : '門市代碼格式不正確';

// ---------- CORS：只允許公司網站與本機開發 ----------
const ORIGIN_PATTERNS = [
  /^https:\/\/([a-z0-9-]+\.)*linyaomedical\.com$/i,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i,
];
const EXTRA_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const isAllowedOrigin = (o: string | null) => !!o && (EXTRA_ORIGINS.includes(o) || ORIGIN_PATTERNS.some((p) => p.test(o)));
function corsHeadersFor(origin: string | null): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
  if (isAllowedOrigin(origin)) h['Access-Control-Allow-Origin'] = origin!;
  return h;
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req.headers.get('Origin'));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors } });

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: '不支援的請求方式' }, 405);

  try {
    // ---------- 1. 驗證呼叫者 ----------
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: '未登入或 token 無效' }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: { user }, error: userErr } = await admin.auth.getUser(jwt);
    if (userErr || !user) return json({ error: '未登入或 token 無效' }, 401);

    const { data: me } = await admin.from('rx_users').select('role, active').eq('id', user.id).single();
    if (me?.role !== 'admin' || me?.active === false) return json({ error: '僅系統管理員可以執行此操作' }, 403);

    // ---------- 2. 解析輸入 ----------
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: '請求內容格式不正確' }, 400); }
    if (!body || typeof body !== 'object') return json({ error: '請求內容格式不正確' }, 400);

    const audit = (action: string, detail: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ audit: true, system: 'rx', at: new Date().toISOString(), actor: user.id, action, ...detail }));

    // 目標使用者必須是寄單系統的帳號
    async function rxTarget(userId: unknown) {
      if (!isUuid(userId)) return null;
      const { data } = await admin.from('rx_users').select('id, account, role, store_id, active').eq('id', userId).single();
      return data;
    }

    // ---------- 3. 各動作 ----------
    if (body.action === 'create') {
      const { account, password, display_name, role, store_id } = body;
      const r = (role ?? 'store') as string;
      const bad = checkAccount(account) || checkName(display_name) || checkRole(r) || checkStore(store_id) || checkPassword(password);
      if (bad) return json({ error: bad }, 400);
      if (r === 'store' && !store_id) return json({ error: '門市帳號需要指定門市' }, 400);

      const acc = (account as string).trim().toLowerCase();
      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: toAuthEmail(acc), password: password as string, email_confirm: true,
      });
      if (createErr) return json({ error: /already/i.test(createErr.message) ? '帳號已存在' : createErr.message }, 400);

      const newId = created.user.id;
      // 任何一步失敗就把剛建立的登入帳號刪掉，避免留下沒有資料的半成品帳號
      const rollback = async () => { await admin.auth.admin.deleteUser(newId); };

      // SQL 觸發器已建立 rx_users（預設門市、未指定門市）；這裡寫入正確的角色與門市
      const { error: pErr } = await admin.from('rx_users').upsert({
        id: newId, account: acc, display_name: ((display_name as string) || acc).trim(),
        role: r, store_id: (store_id as string) || null, active: true,
      });
      if (pErr) { await rollback(); return json({ error: pErr.message }, 400); }

      audit('create_user', { target: newId, account: acc, role: r, store_id });
      return json({ ok: true, userId: newId });
    }

    if (body.action === 'update') {
      const { userId, account, display_name, role, store_id } = body;
      const target = await rxTarget(userId);
      if (!target) return json({ error: '找不到這位使用者' }, 404);
      const r = (role ?? target.role) as string;
      const bad = checkName(display_name) || checkRole(r) || checkStore(store_id);
      if (bad) return json({ error: bad }, 400);
      if (r === 'store' && !store_id) return json({ error: '門市帳號需要指定門市' }, 400);
      if (userId === user.id && r !== 'admin') return json({ error: '不能取消自己的管理員身分' }, 400);

      const newAcc = String(account ?? target.account).trim().toLowerCase();
      if (newAcc !== target.account) {
        const accBad = checkAccount(newAcc);
        if (accBad) return json({ error: accBad }, 400);
        // 帳號變更 → 登入信箱也要跟著變
        const { error: emailErr } = await admin.auth.admin.updateUserById(userId as string, { email: toAuthEmail(newAcc), email_confirm: true });
        if (emailErr) return json({ error: /already/i.test(emailErr.message) ? '帳號已存在' : emailErr.message }, 400);
      }
      const { error: pErr } = await admin.from('rx_users').update({
        account: newAcc, display_name: ((display_name as string) || newAcc).trim(), role: r, store_id: (store_id as string) || null,
      }).eq('id', userId);
      if (pErr) return json({ error: pErr.message }, 400);

      audit('update_user', { target: userId, account: newAcc, role: r, store_id });
      return json({ ok: true });
    }

    if (body.action === 'reset_password') {
      const { userId, password } = body;
      const target = await rxTarget(userId);
      if (!target) return json({ error: '找不到這位使用者' }, 404);
      const bad = checkPassword(password);
      if (bad) return json({ error: bad }, 400);
      const { error } = await admin.auth.admin.updateUserById(userId as string, { password: password as string });
      if (error) return json({ error: error.message }, 400);
      audit('reset_password', { target: userId });
      return json({ ok: true });
    }

    if (body.action === 'set_active') {
      const { userId, active } = body;
      const target = await rxTarget(userId);
      if (!target || typeof active !== 'boolean') return json({ error: '使用者資料格式不正確' }, 400);
      if (userId === user.id && !active) return json({ error: '不能停用自己的帳號' }, 400);

      const { error: pErr } = await admin.from('rx_users').update({ active }).eq('id', userId);
      if (pErr) return json({ error: pErr.message }, 400);
      // 停用時同時封鎖登入（約 10 年），啟用時解除
      const { error: aErr } = await admin.auth.admin.updateUserById(userId as string, { ban_duration: active ? 'none' : '87600h' });
      if (aErr) return json({ error: aErr.message }, 400);
      audit('set_active', { target: userId, active });
      return json({ ok: true });
    }

    return json({ error: '未知的 action' }, 400);
  } catch (e) {
    // 詳細錯誤只寫進 Function Logs，不回傳給前端
    console.error('rx-admin-users 發生未預期錯誤', e);
    return json({ error: '伺服器發生錯誤，請稍後再試' }, 500);
  }
});
