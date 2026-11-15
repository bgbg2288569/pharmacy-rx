# 調劑輸出程式 → 處方寄單系統　串接 API 規格（v1.14）

> 用途：調劑輸出程式（Form1.vb）在調劑慢箋時，把病人與處方資料打包送到寄單系統，直接建立寄單並回傳寄單編號，接著列印 4×3 寄單貼紙。
> 狀態：v1.14 已實作（資料庫函式 `rx_intake`、系統管理「調劑串接」、RxBridge 貼紙列印、FormRxDeposit 確認視窗）。
> Designed by Tom 蔡育霖藥師

---

## 1. 整體流程

```
調劑輸出程式（櫃台電腦）
  │ ① 處方清單按右鍵 →「建立寄單」
  │ ② FormRxDeposit 視窗：從處方 XML、藥局備註帶入資料
  │    → 自動「試算」一次（p_dry_run = true）：帶出醫院／科別名稱、檢查欄位、列出提醒，不建立寄單
  │ ③ 藥師確認／修改電話、通知方式、領藥日、輸入人員代碼 → 按「確定寄單」
  ▼
POST https://<專案代碼>.supabase.co/rest/v1/rpc/rx_intake        （HTTPS）
  │ ④ 驗證門市 API 金鑰 → 檢查資料 → 建立寄單（與網頁「寄單輸入」同一套規則）
  ▼
回應 JSON：寄單編號、各次領藥日、貼紙要印的內容（label）
  │ ⑤ 把 label 送給本機 RxBridge
  ▼
POST http://localhost:5880/print-label  → RxBridge 用 ini 指定的貼紙印表機直接列印（不跳對話框）
```

- **一定要經過確認視窗才會送出**：處方 XML 的電話可能跟實際聯絡電話不同，藥師在視窗裡改好才寄單。
- 寄單網頁不用開著；資料會出現在「寄單查詢」「預作確認」，建檔人員記為輸入的人員代碼。
- 網頁補印和調劑系統用同一個 RxBridge 貼紙版面（第 8 節）。

---

## 2. 連線與驗證

| 項目 | 內容 |
|---|---|
| 網址 | `POST https://<專案代碼>.supabase.co/rest/v1/rpc/rx_intake` |
| Header | `apikey: <anon key>`、`Authorization: Bearer <anon key>`、`Content-Type: application/json` |
| Body | `{ "p_key": "rxk_…門市 API 金鑰", "p": { …第 3 節的寄單資料… }, "p_dry_run": false }` |
| 編碼 | UTF-8 JSON |
| TLS | 需 TLS 1.2 以上（.NET Framework 4.x 要先設定，FormRxDeposit 已處理） |

- anon key 本來就公開在網頁裡，只能呼叫 `rx_intake`，讀不到任何資料表；**真正的權限由門市 API 金鑰控管**。
- 金鑰在「系統管理 › 調劑串接」產生，只會顯示一次；資料庫只存雜湊值。外洩時停用、重新產生即可。
- 一把金鑰只對應一間門市，寄單一律建在該門市。
- `p_dry_run: true`：只試算，不建立寄單（確認視窗開啟時、按「重新檢查」時使用）。

---

## 3. 請求格式

```json
{
  "client_ref": "A123456789_1151114_093015.xml|2026-11-14 09:30:15",
  "staff_code": "180",
  "patient_name": "王美玲",
  "birth_date": "0520115",
  "phone": "0229001234",
  "mobile": "0912345678",
  "ext_patient_id": "C00123",
  "pharmacy_memo": "盤尼西林過敏；LINE通知",
  "notify_methods": [],
  "hospital_code": "0401180014",
  "hospital_name": "",
  "dept_code": "AB",
  "dept_name": "",
  "rx": { "dispense_date": "1151114", "days": 28, "current_seq": 1, "total": 3 },
  "fills": [],
  "note": "",
  "print": true
}
```

### 欄位說明

| 欄位 | 必填 | 格式 | 說明 |
|---|---|---|---|
| `client_ref` | ✔ | 字串 ≤ 200 | **防止重複建立**。同一門市同一個值只會建一張寄單，重送會回傳原本那張（`duplicate: true`）。建議用「處方檔名\|檔案時間」。 |
| `staff_code` |  | 人員代碼 | 寄單系統的人員代碼。不填則記為金鑰設定的預設人員（例：「調劑系統」）。代碼不存在會回錯誤。 |
| `patient_name` | ✔ | ≤ 40 字 | 病人姓名（XML `person@name`）。 |
| `birth_date` |  | `YYYMMDD`（民國）或 `YYYY-MM-DD` | XML `person@birth` 直接帶入即可。 |
| `phone` |  | 數字 | 市話（XML `person@phone`），非數字字元會被去掉。 |
| `mobile` |  | 數字 | 手機（XML `person@mobile`）。**伺服器優先用手機**，09 開頭必須 10 碼。 |
| `ext_patient_id` |  | 字串 | 藥局系統客戶代號（sa100.cus_no）等，僅供查詢對照。 |
| `pharmacy_memo` |  | 字串 | 藥局系統客戶備註（sa110.allergy，即 `FetchAllergyText` 的結果）。`notify_methods` 為空時用它判斷通知方式：含 LINE → LINE、含「簡訊」→ 簡訊、含「電話」→ 電話。**只用來判斷，不存進寄單**。 |
| `notify_methods` |  | 陣列 | `LINE` `簡訊` `電話` `自取` 任意組合。有給就以此為準。都判斷不出來時用門市「寄單預設值」。 |
| `hospital_code` | ✔＊ | 10 碼院所代號 | XML `case@from`。伺服器用院所清單自動帶出名稱。 |
| `hospital_name` |  | 字串 | 院所代號查不到時才用；兩者至少要有一個。 |
| `dept_code` |  | 科別代碼 | XML `study@subject`（健保就醫科別，例 `01` 家醫科、`09` 耳鼻喉科）。伺服器用科別清單帶出名稱。 |
| `dept_name` |  | 字串 | 清單外科別時填。 |
| `rx` | ✔＊ | 物件 | 讓伺服器自動算領藥日（見第 5 節）。 |
| `fills` | ✔＊ | 陣列 | 直接指定領藥日，優先於 `rx`。格式 `[{ "seq": 2, "due_date": "2026-12-02" }]`，`due_date` 也可用民國 `1151202`。 |
| `note` |  | ≤ 200 字 | 寄單備註。 |
| `print` |  | true/false | 只是記錄「要不要印」，實際列印由呼叫端交給 RxBridge。預設 true。 |

＊ `rx` 與 `fills` 至少給一個；`hospital_code` 與 `hospital_name` 至少給一個。

### 驗證規則（與網頁寄單輸入相同）
- 姓名必填；通知方式至少一種。
- 選了「簡訊」或「電話」就要有電話；電話至少 8 碼、最多 10 碼；09 開頭必須 10 碼。
- 至少一次領藥日；後一次不可早於前一次；`seq` 只能是 1～3。
- 生日不可晚於今天。

---

## 4. 調劑 XML → API 欄位對照

| API 欄位 | 調劑 XML／程式來源 |
|---|---|
| `patient_name` | `//person/@name` |
| `birth_date` | `//person/@birth`（民國 7 碼） |
| `phone` / `mobile` | `//person/@phone` / `//person/@mobile` |
| `hospital_code` | `case/@from` |
| `dept_code` | `//study/@subject` |
| `rx.dispense_date` | 調劑日（`TextBox_Date` 轉民國，或 `case/@date`） |
| `rx.days` | `//orders/@days`（若有加藥天數，用加藥前的處方天數） |
| `rx.current_seq` | 這次是第幾次調劑（`//continous_prescription` 的「目前次數」屬性，**待確認屬性名稱**） |
| `rx.total` | `//continous_prescription/@total` |
| `pharmacy_memo` | `FetchAllergyText(身分證)` |
| `client_ref` | `fileName & "|" & fileTime` |

---

## 5. 領藥日自動計算（`rx`）

依健保慢箋規則：下一次可在上次給藥期間屆滿前 **10 日內** 領藥，寄單記錄「可領藥的第一天」。

```
第 n 次領藥日 = 調劑日 + 處方天數 × (n − 目前次數) − 10 天        （n = 目前次數+1 … total）
```

| 例 | 調劑日 | 天數 | 目前次數/總次數 | 建立的領藥日 |
|---|---|---|---|---|
| A | 115/11/14 | 28 | 1/3 | 第 2 次 115/12/02、第 3 次 115/12/30 |
| B | 115/11/14 | 30 | 2/3 | 第 3 次 115/12/04 |
| C | 115/11/14 | 28 | 3/3 | 沒有可寄的次數 → 回錯誤 `NO_REMAINING_FILL` |

- 舊寄單系統的區間（例 1123-1202）也是取第一天，與此一致。
- 如果門市習慣不同（例如提前 7 天），之後可在門市設定加「提前天數」，預設 10。

---

## 6. 回應格式

### 成功（HTTP 200）
```json
{
  "ok": true,
  "duplicate": false,
  "order_id": 12345,
  "order_no": "26111400057",
  "order_no_fmt": "261114-0005-7",
  "notify_methods": ["LINE"],
  "fills": [
    { "seq": 2, "due_date": "2026-12-02", "roc": "115/12/02" },
    { "seq": 3, "due_date": "2026-12-30", "roc": "115/12/30" }
  ],
  "warnings": ["王美玲 已有未完成寄單 261101-0003-1（台大 心臟血管內科）"],
  "label": {
    "order_no": "26111400057",
    "order_no_fmt": "261114-0005-7",
    "patient_name": "王美玲",
    "hospital": "台大",
    "dept": "心臟血管內科",
    "phone": "0912345678",
    "notify": "LINE通知",
    "fills": [ { "seq": 2, "md": "12/02" }, { "seq": 3, "md": "12/30" } ]
  }
}
```
- `warnings`：不會擋下建立，只是提醒（例如同一病人還有未完成寄單、領藥日早於門市最新預作日）。建議在調劑輸出程式跳訊息給藥師看。
- `label`：貼紙要印的內容，**原封不動轉送給 RxBridge 列印**即可（第 8 節）。

### 失敗
```json
{ "ok": false, "code": "VALIDATION", "field": "mobile", "message": "手機（09 開頭）須為 10 碼" }
```

HTTP 一律回 200，以 `ok` 判斷成功與否（連線、網址或 anon key 錯誤才會是 4xx／5xx）。

| code | 意義／處理方式 |
|---|---|
| `BAD_KEY` | 門市 API 金鑰錯誤或已停用 |
| `VALIDATION` | 欄位不符規則，`message` 可直接顯示；試算時會附 `preview` |
| `NO_REMAINING_FILL` | 依 `rx` 算不出任何要寄的次數（已是最後一次） |
| `STAFF_NOT_FOUND` | 人員代碼錯誤或未啟用 |
| `SERVER` | 伺服器錯誤，可用同一個 `client_ref` 重送（不會重複建立） |

### 試算回應（`p_dry_run: true`）
```json
{ "ok": true, "dry_run": true, "store_id": "03", "store_name": "福原藥局", "staff_name": "調劑系統",
  "preview": { "patient_name": "王美玲", "phone": "0912345678", "notify_methods": ["LINE"],
               "hospital_name": "國立臺灣大學醫學院附設醫院", "dept_name": "心臟血管內科",
               "fills": [{ "seq": 2, "due_date": "2026-12-02" }], "...": "..." },
  "warnings": ["王美玲 已有未完成寄單 261101-0003-1（臺灣大學醫學院附設醫院 心臟血管內科）"] }
```

---|---|---|
| 400 | `BAD_JSON` | JSON 格式錯誤 |
| 400 | `VALIDATION` | 欄位不符規則，`field` 指出哪一欄，`message` 可直接顯示 |
| 400 | `NO_REMAINING_FILL` | 依 `rx` 算不出任何要寄的次數（已是最後一次） |
| 401 | `BAD_KEY` | 金鑰錯誤或已停用 |
| 404 | `STAFF_NOT_FOUND` | 人員代碼不存在 |
| 500 | `SERVER` | 伺服器錯誤，可用同一個 `client_ref` 重送（不會重複建立） |

---

## 7. 重送與網路中斷
- 送出後沒收到回應（逾時、斷線），**直接用同一個 `client_ref` 重送**，不會建立第二張。
- 不要每次重送都換新的 `client_ref`。

---

## 8. 列印貼紙（RxBridge）

瀏覽器（Chrome、Edge）的網頁程式無法指定印表機，所以列印統一交給 RxBridge：

```
POST http://localhost:5880/print-label
Content-Type: application/json; charset=utf-8

{ "label": { ...rx_intake 回應的 label... }, "copies": 1 }
```

回應 `{ "ok": true, "printer": "TSC TTP-244 Pro" }`。

- 印表機在 `RxBridge.ini` 設定：`LabelPrinter=TSC TTP-244 Pro`（Windows「印表機」裡顯示的名稱）。
- 版面與網頁 4×3 貼紙相同：左 QR＋寄單編號；右姓名、醫院、科別、電話、通知方式；粗線下方 ➋12/02 ➌12/30。
- 網頁「寄單輸入」「補印貼紙」也會改成優先送 RxBridge 列印；RxBridge 沒開時才退回瀏覽器列印。

---

## 9. 調劑輸出程式要加的檔案

- `dispensing/FormRxDeposit.vb`：確認視窗（控制項都在程式裡建立，不需要設計工具檔），含試算、送出、交給 RxBridge 列印。
- `dispensing/Form1_寄單串接.vb.txt`：貼進 Form1 的右鍵選單事件，以及要新增的 4 個設定值（RxApiUrl、RxAnonKey、RxApiKey、RxBridgeUrl）。
- 專案參考：`System.Net.Http`、`System.Web.Extensions`。

確認視窗的欄位：姓名、生日、電話（下拉可選手機／市話，也可直接修改）、通知方式（依藥局備註預選）、醫院、科別、調劑日／天數／本次第幾次／共幾次／提前天數（改了會重算領藥日）、第 1～3 次領藥日（可直接修改）、備註、人員代碼、是否列印貼紙。

## 10. 注意事項
1. 「本次第幾次」會依序嘗試 `continous_prescription` 的 `count`、`times`、`seq`、`current`、`now`、`no` 屬性，都沒有就預設第 1 次；確認視窗可以手動改。實際屬性名稱確認後可以只保留那一個。
2. 提前天數預設 10 天（健保慢箋屆滿前 10 日內可領），可在視窗調整。
3. 日新、博亞的病人備註在 SJDB MEMBER.REMARK，`FetchAllergyText` 已經會依模式讀取，一樣可以用。
