@echo off
REM 以「系統管理員身分」執行一次，允許一般使用者啟動 RxBridge 的本機服務
netsh http add urlacl url=http://localhost:5880/ user=Everyone
netsh http add urlacl url=http://127.0.0.1:5880/ user=Everyone
pause
