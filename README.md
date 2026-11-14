# 處方寄單系統 v1.0

凌曜醫療 · Designed by Tom 蔡育霖藥師
正式網址（預定）：<https://pharmacy-rx.linyaomedical.com>

流程：寄單 → 預作確認 → 預作通知。每一步都會記錄時間與操作人員；寄單流程到「已通知」結束，之後的領藥回到藥局系統處理（只選「自取」的寄單，預作完成就算結束）。

```
pharmacy-rx/
├─ package.json          Railway 啟動設定（用 serve 提供 web/ 靜態網頁）
├─ web/                  前端網頁（Vue 3，不需建置）
│  ├─ index.html
│  ├─ serve.json         快取與目錄設定
│  ├─ css/app.css
│  ├─ vendor/            Vue、Supabase、QR code 套件（固定版本，自行託管）
│  └─ js/  config.js ← 要填 Supabase 連線資訊 · lib.js · print.js · components.js · app.js · pages/*.js
├─ sql/
│  ├─ 01_schema.sql              資料表、權限（RLS）、函式；可重複執行
│  ├─ 02_seed_departments.sql    科別 59 筆
│  └─ 03_seed_hospitals_1~3.sql  醫院 21,748 筆
├─ supabase/functions/rx-admin-users/index.ts   管理頁「新增帳號／重設密碼」用
├─ bridge/               RxBridge：福原藥局本機 ODBC 橋接程式（VB.NET）
└─ demo/                 產生單檔試用版（npm install → npm run build）
```

資料庫物件全部以 `rx_` 開頭：12 張資料表（`rx_stores`、`rx_users`、`rx_staff`、`rx_hospitals`、`rx_departments`、`rx_hospital_quick`、`rx_phrases`、`rx_settings`、`rx_orders`、`rx_fills`、`rx_logs`、`rx_counters`），以及 1 個檢視表 `rx_fill_view`，函式也都是 `rx_` 開頭。所以可以和其他系統放在同一個 Supabase 專案，不會互相衝突。

---

## 步驟一：Supabase 資料庫

### 1-1 建立專案
- 建議使用獨立專案（Pro 方案）。區域選 **Northeast Asia (Tokyo)**，離台灣最近。
- 若和現有專案共用，直接用原專案即可，不需要另外處理。

### 1-2 建立資料表
到 Supabase 後台的 **SQL Editor**，依序貼上並執行（每個檔案按一次 Run）：
1. `sql/01_schema.sql`
2. `sql/02_seed_departments.sql`
3. `sql/03_seed_hospitals_1.sql`
4. `sql/03_seed_hospitals_2.sql`
5. `sql/03_seed_hospitals_3.sql`

> `01_schema.sql` 最後建立了三個預設門市：03 福原、04 日新、07 博亞。**博亞的代碼 07 是暫定的**，請在執行前改成實際代碼，或上線後到「系統管理 → 門市」修改。

### 1-3 關閉公開註冊（重要）
**Authentication → Sign In / Providers → Email**，關閉 **Allow new users to sign up**。
系統的帳號一律由管理員在管理頁建立，關閉公開註冊可以避免外人自行申請帳號。

### 1-4 建立第一個管理員
1. **Authentication → Users → Add user → Create new user**
   - Email：`admin@rx.linyao.local`
   - Password：自訂
   - 勾選 **Auto Confirm User**
2. 回到 SQL Editor 執行：
   ```sql
   update rx_users set role = 'admin', display_name = '管理員', store_id = '03' where account = 'admin';
   ```

### 1-5 部署帳號管理功能（Edge Function）
部署後，管理員就能直接在網頁上新增帳號、修改帳號、重設密碼、停用帳號（做法與調撥系統的 `admin-users` 相同）。
這支函式只接受公司網址（`*.linyaomedical.com`）和本機（localhost）的呼叫。如果要用 Railway 預設網址（`xxx.up.railway.app`）測試，請到 **Edge Functions → Secrets** 新增 `ALLOWED_ORIGINS`，值填那個網址（例：`https://xxx.up.railway.app`）。

以下兩種方式擇一：

**方式 A：在後台貼上程式碼（最簡單）**
**Edge Functions → Deploy a new function → Via Editor**，函式名稱填 `rx-admin-users`，貼上 `supabase/functions/rx-admin-users/index.ts` 的內容後按 Deploy。

**方式 B：用 VS Code 終端機**
```bash
npx supabase login
npx supabase functions deploy rx-admin-users --remote=你的專案代碼 --use-api
```

> 部署完成後，在後台 **Edge Functions** 清單應該看得到 `rx-admin-users`。
> 若建立帳號時出現 401（驗證被擋），再加上 `--no-verify-jwt` 重新部署；函式內部本來就會檢查呼叫者是不是管理員，關閉平台驗證不會降低安全性。

### 1-6 取得連線資訊
到 **Project Settings → API Keys**，複製以下兩項：
- **Project URL**（例：`https://abcdxyz.supabase.co`）
- **anon public key**（或新版的 publishable key，兩種都可以用）

> 只能複製 anon／publishable key。**service_role（secret）key 絕對不要放進前端。**

---

## 步驟二：VS Code 本機設定與測試

1. 安裝 [Node.js 20 LTS 以上](https://nodejs.org)、[Git](https://git-scm.com)、VS Code。
2. 解壓縮專案，資料夾名稱改成 `pharmacy-rx`，然後在 VS Code 用「檔案 → 開啟資料夾」開啟。
3. 編輯 `web/js/config.js`，填入步驟 1-6 的 `SUPABASE_URL` 和 `SUPABASE_ANON_KEY`。
4. 開啟 VS Code 終端機（Ctrl + `），依序執行：
   ```bash
   npm install
   npm run dev
   ```
5. 用瀏覽器開啟 <http://localhost:3000>，用 `admin` 和你設定的密碼登入，確認系統可以正常使用。

> 網頁使用 JavaScript 模組，不能直接雙擊 `index.html` 開啟，一定要透過 `npm run dev`（或 VS Code 的 Live Server 擴充功能）。

---

## 步驟三：上傳到 GitHub

建議建立 **Private（私人）** repository，名稱用 `pharmacy-rx`。

**方式 A：VS Code**
左側「原始檔控制」→「發佈到 GitHub」→ 選擇 Private。

**方式 B：終端機**
```bash
git init
git add .
git commit -m "處方寄單系統 v1.0"
git branch -M main
git remote add origin https://github.com/你的帳號/pharmacy-rx.git
git push -u origin main
```

---

## 步驟四：Railway 部署

1. Railway → **New Project → Deploy from GitHub repo** → 選擇 `pharmacy-rx`。
2. Railway 會自動偵測到 Node.js，接著執行 `npm install`，再用 `npm start` 啟動，**不需要設定任何環境變數**。
3. 到 Service → **Settings → Networking → Generate Domain**，會產生一組 `xxxx.up.railway.app` 網址，先用它測試能不能登入。
4. 之後每次 `git push` 到 main 分支，Railway 都會自動重新部署。

---

## 步驟五：設定公司網域 pharmacy-rx.linyaomedical.com

1. 在 Railway 的 Service → **Settings → Networking → Custom Domain** 輸入 `pharmacy-rx.linyaomedical.com`，Railway 會顯示**兩筆** DNS 紀錄：一筆 CNAME 和一筆 TXT。
2. 到 linyaomedical.com 的 DNS 管理頁面（與現有的 hr／app／pos 子網域同一個地方）新增這兩筆紀錄：

   | 類型 | 主機名稱 | 值 |
   |---|---|---|
   | CNAME | `pharmacy-rx` | Railway 顯示的目標，例：`abc123.up.railway.app` |
   | TXT | `_railway-verify.pharmacy-rx` | Railway 顯示的 `railway-verify=…` 整串 |

   > **兩筆都必須加。** 只加 CNAME 的話，網址會一直停在驗證中或顯示 404。TXT 的主機名稱是 `_railway-verify.pharmacy-rx`，不是只有 `_railway-verify`。
3. 等 Railway 那邊出現綠色勾勾（通常幾分鐘，最長約 24 小時），SSL 憑證會自動申請完成。
4. 回到 Supabase 的 **Authentication → URL Configuration**，把 Site URL 設成 `https://pharmacy-rx.linyaomedical.com`。

---

## 步驟六：上線前的系統設定（用管理員帳號操作）

1. **系統管理 → 門市**：確認各門市的代碼和名稱。
2. **系統管理 → 帳號**：為每間門市建立共用帳號，例如 `fuyuan`、`rixin`、`boya`，角色選「門市」並指定門市。
3. **系統管理 → 人員代碼**：每位藥師、助理各建一組代碼。支援多間門市的人員請選「全門市通用」。
4. **門市設定**（各門市分別設定）：
   - 寄單預設值：預設通知方式、預設醫院、預設科別、常用科別
   - 常用醫院快速碼（8～10 間剛好兩列）
   - 常用片語、取消原因
   - 通知訊息範本
   - 本機列印格式，按「測試列印」確認版面
5. **免跳出列印對話框**（每台櫃台電腦設定一次）：在 Chrome 捷徑的「目標」最後加上 ` --kiosk-printing`，並在 Windows 把標籤機或發票機設成預設印表機。

---

## 步驟七：福原藥局 RxBridge（本機藥局系統連線）

1. 用 Visual Studio 開啟 `bridge/RxBridge.vbproj`（.NET Framework 4.8、**x86**）並建置。
2. **修改 `RxBridge.ini` 的 `Query`**：目前是範例，請改成藥局系統病患資料表的實際表名和欄位。欄位別名必須是 `name, phone, ext_id, birthday, last_visit`。
3. `AllowedOrigins` 已經設成 `https://pharmacy-rx.linyaomedical.com`。在本機測試時可以暫時改成 `*`。
4. 以系統管理員身分執行一次 `setup_urlacl.bat`。
5. 把 `RxBridge.exe` 的捷徑放進 Windows「啟動」資料夾，開機後會自動常駐在系統匣。
6. 在寄單系統的「門市設定 → 本地藥局系統連線」填入 `http://localhost:5880`，按「測試連線」。Chrome 第一次會詢問是否允許存取本機網路，請按「允許」。

---

## 日後更新

1. 在 VS Code 修改程式碼，用 `npm run dev` 在本機測試。
2. `git commit`，再 `git push`，Railway 會自動部署，約 1～2 分鐘後生效。
3. 資料庫有異動時，在 SQL Editor 重新執行 `01_schema.sql` 即可（可重複執行，不會影響既有資料）。

---

## 功能速查

| 功能 | 說明 |
|---|---|
| 寄單輸入 | Enter 跳下一欄；F1 儲存並列印、F2 儲存、F3 清除；未儲存的內容切換頁面仍會保留（登出、重新整理或切換門市才會清空） |
| 日期 | 輸入 `1120` 或 `1151120`，也可以點 📅 開啟民國年日曆；生日可輸入隱碼，例如 `75/**/12` |
| 最新預作日 | 在預作確認頁確認時自動更新；寄單時領藥日早於或等於這一天會警示「請直接打單調劑」 |
| 同行家人 | 寄單後按「＋寄同行家人」，或事後在寄單明細連結；預作通知頁會把家人排在一起、合併訊息 |
| 寄單編號 | 共 11 碼：西元年月日 6 碼＋流水號 4 碼＋檢核碼 1 碼（Luhn），例：`261113-0001-3` |
| 列印 | 貼紙 4×3cm（正式版面）、發票紙 57mm 和 A5（暫定版面，待提供實際樣式後調整） |

## 附錄：舊寄單系統資料匯入（福原 03）

1. 先重新執行一次 `sql/01_schema.sql`（可重複執行，會更新驗證與查詢函式）。
2. 依序在 SQL Editor 執行（每個檔案貼上後按 Run）：
   - `sql/import/10_import_old_1.sql`
   - `sql/import/11_import_old_2.sql`
   - `sql/import/12_import_old_apply.sql`
3. 第 3 個檔案最後會列出匯入後的寄單狀態筆數；重複執行會被擋下，不會重複匯入。
4. `sql/import/匯入檢核清單.xlsx` 列出需要人工核對的資料（Excel 列號、原始內容、處理方式）。
5. 人員代碼的姓名先填「待補資料」，到「系統管理 › 人員代碼」補上即可。
6. 重新產生 SQL：`python3 tools/import_old.py 舊資料.xlsx sql/import`
