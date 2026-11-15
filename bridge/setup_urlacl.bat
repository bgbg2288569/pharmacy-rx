@echo off
REM RxBridge寄單系統串接：允許一般使用者啟動本機服務（每台電腦以「系統管理員身分」執行一次）
REM 用 SDDL（WD = Everyone 的 SID）設定，不受中文／英文 Windows 群組名稱影響

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo  [錯誤] 請對這個檔案按右鍵，選「以系統管理員身分執行」
  echo.
  pause
  exit /b 1
)

netsh http delete urlacl url=http://localhost:5880/ >nul 2>&1
netsh http delete urlacl url=http://127.0.0.1:5880/ >nul 2>&1
netsh http add urlacl url=http://localhost:5880/ sddl=D:(A;;GX;;;WD)
netsh http add urlacl url=http://127.0.0.1:5880/ sddl=D:(A;;GX;;;WD)

echo.
echo  設定完成，請重新開啟 RxBridge寄單系統串接
echo.
pause
