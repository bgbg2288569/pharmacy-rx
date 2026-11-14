// Supabase Edge Function：管理員建立帳號 / 重設密碼
// 部署：supabase functions deploy rx-admin-users
// 需要環境變數（Supabase 會自動提供）：SUPABASE_URL、SUPABASE_ANON_KEY、SUPABASE_SERVICE_ROLE_KEY
// 選填：RX_EMAIL_DOMAIN（預設 rx.linyao.local，需與前端 config.js 一致）
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const domain = Deno.env.get("RX_EMAIL_DOMAIN") ?? "rx.linyao.local";
    // 以呼叫者身分確認是管理員
    const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: isAdmin, error: e1 } = await caller.rpc("rx_is_admin");
    if (e1 || !isAdmin) return reply({ error: "只有管理員可以管理帳號" }, 403);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const b = await req.json();
    const account = String(b.account ?? "").trim().toLowerCase();
    if (!/^[a-z0-9._-]{2,40}$/.test(account)) return reply({ error: "帳號只能用英數字與 . _ -" }, 400);
    const email = `${account}@${domain}`;

    if (b.action === "create") {
      if (!b.password) return reply({ error: "請輸入密碼" }, 400);
      const { data, error } = await admin.auth.admin.createUser({
        email, password: String(b.password), email_confirm: true,
        user_metadata: { display_name: b.display_name || account, role: b.role === "admin" ? "admin" : "store", store_id: b.store_id || "" },
      });
      if (error) return reply({ error: /already/i.test(error.message) ? "帳號已存在" : error.message }, 400);
      // trigger 已建立 rx_users；再確保欄位正確
      await admin.from("rx_users").upsert({
        id: data.user.id, account, display_name: b.display_name || account,
        role: b.role === "admin" ? "admin" : "store", store_id: b.store_id || null, active: true,
      });
      return reply({ ok: true, id: data.user.id });
    }

    if (b.action === "reset_password") {
      const { data: u } = await admin.from("rx_users").select("id").eq("account", account).maybeSingle();
      if (!u) return reply({ error: "找不到此帳號" }, 404);
      const { error } = await admin.auth.admin.updateUserById(u.id, { password: String(b.password) });
      if (error) return reply({ error: error.message }, 400);
      return reply({ ok: true });
    }
    return reply({ error: "未知的動作" }, 400);
  } catch (e) {
    return reply({ error: String(e?.message ?? e) }, 500);
  }
});
