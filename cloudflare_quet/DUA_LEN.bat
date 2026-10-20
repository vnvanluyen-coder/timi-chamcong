@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Dua ban moi cua may chu quet nhanh len Cloudflare...
call npx --yes wrangler@4.20.0 deploy
echo.
echo XONG neu thay dong "Deployed timi-quet-don". Bao Claude.
pause
