// 部署前請填入 Supabase 連線資訊（Supabase 後台 → Project Settings → API）
// anon key 本來就會出現在瀏覽器裡，安全性由資料庫的 RLS 權限控管，放在這裡沒有問題；
// 千萬不要把 service_role key 放進前端。
export const CONFIG = {
  SUPABASE_URL: 'https://kvckeegglkuqyxjcxzlv.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_p597PlH_WSr3m9wFP3KShg_Xzm4ASK6',
  // 登入帳號會自動補上此網域變成 email，例：fuyuan → fuyuan@rx.linyao.local（需與 SQL、Edge Function 一致）
  EMAIL_DOMAIN: 'rx.linyao.local',
  APP_NAME: '處方寄單系統',
  VERSION: 'v1.0.0',
};
