# RxBridge寄單系統串接（v1.4.1）安裝說明

在藥局櫃台電腦背景執行（系統匣圖示），提供：
1. **藥局系統客戶查詢**：寄單網頁輸入姓名／電話／民國生日／身分證時，查 sa100＋sa110（ODBC）。
2. **4×3 寄單貼紙列印**：寄單網頁「儲存並列印」「補印貼紙」與調劑輸出程式「建立寄單」都送到這裡，直接印到指定印表機，不跳列印視窗。

只在本機 `http://localhost:5880` 提供服務，資料不經過網路。

## 檔案

| 檔案 | 說明 |
|---|---|
| `RxBridge.vb` | 程式碼 |
| `RxBridge.vbproj` | 專案檔（.NET Framework 4.8、x86、QRCoder 套件） |
| `RxBridge.ini` | 設定檔（檔名固定，放在 exe 旁） |
| `RxBridge.ico` | 圖示（與寄單網頁相同） |
| `setup_urlacl.bat` | 第一次安裝時以系統管理員身分執行一次 |

## 建置
1. 用 Visual Studio 開啟 `RxBridge.vbproj`（第一次會自動還原 QRCoder 套件）。
2. 組態選 **Release**、平台 **x86**（ODBC 驅動程式是 32 位元）→ 建置。
3. 輸出資料夾 `bin\Release\net48\` 會有：
   - `RxBridge寄單系統串接.exe`
   - `QRCoder.dll`
   - `RxBridge.ini`、`RxBridge.ico`、`setup_urlacl.bat`

## 安裝到櫃台電腦
1. 把上面整個輸出資料夾複製到例如 `C:\RxBridge\`。
2. 對 `setup_urlacl.bat` 按右鍵 →「以系統管理員身分執行」（只需一次）。
3. 編輯 `RxBridge.ini`：
   - `LabelPrinter=` 填貼紙印表機名稱（Windows「印表機與掃描器」裡顯示的名稱）。
   - `ConnectionString` 與調劑輸出程式相同。
4. 執行 `RxBridge寄單系統串接.exe`，右下角出現雙圓圖示。
5. 開機自動執行：按 `Win＋R` 輸入 `shell:startup`，把 exe 的捷徑放進去。

## 系統匣選單（圖示按右鍵）
- **測試查詢…**：輸入姓名、電話、民國生日或身分證測試藥局系統查詢。
- **測試列印貼紙**：印一張測試貼紙，用來確認印表機與位置。
- **重新載入設定**：修改 ini 後不用重開程式。
- **結束**

## 寄單網頁設定
門市設定 › 藥局系統連線：
- 連線網址：`http://localhost:5880`
- 勾選「4×3 貼紙交給 RxBridge 直接列印」

## 貼紙位置微調
印出來偏移時調整 ini（單位 mm，可為負數），改完按「重新載入設定」再「測試列印貼紙」：
```
LabelOffsetXmm=0     ; 正數往右
LabelOffsetYmm=0     ; 正數往下
```

## 確認是否正常
瀏覽器打開：
- `http://localhost:5880/health` → 顯示 `"ok":true` 與版本 `1.4.1`
- `http://localhost:5880/patients?q=王` → 顯示查詢結果

## 從舊版更新
1. 關閉舊的 RxBridge（系統匣右鍵 → 結束）。
2. 舊的 `RxBridge.exe` 可刪除，改用新的 `RxBridge寄單系統串接.exe`；開機捷徑也要換成新的。
3. **保留原本的 `RxBridge.ini`**，只補上新版多出的設定（`LabelPrinter` 等貼紙列印設定、`CodePage`、`QueryBirth`）。

## v1.5.0：掃描處方箋 QR 比對
- 新增 `GET /match?idno=A123***481&birth=1966-**-26`：身分證／生日的 `*` 隱碼當萬用字元比對 sa100。
- 身分證完整 → `QueryIdno`；有隱碼 → `QueryMatch`（`idno LIKE ? AND birthday LIKE ?`）；只有完整生日 → `QueryBirth`。
- 舊版 ini 升級時，請把 `QueryMatch` 那段加進 exe 旁的 RxBridge.ini（沒有這段，掃 QR 時藥局系統查不到資料）。
