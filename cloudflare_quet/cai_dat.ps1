# Cài máy chủ ghi đơn nhanh lên Cloudflare + nối với bot quét đơn. Chạy bằng CAI_DAT.bat.
$ErrorActionPreference = 'Continue'   # lenh ngoai (npx, clasp) ghi canh bao ra stderr; kiem bang `$LASTEXITCODE
Set-Location $PSScriptRoot
$W = 'wrangler@4.20.0'
$clasp = 'D:\Bot\BotSapo\_luu_tru\apps_script\clasp'
$cred = 'D:\Bot\credentials.json'
Write-Host "`n=== 1/5 Dang nhap Cloudflare (trinh duyet se mo, bam Allow) ===" -ForegroundColor Cyan
npx --yes $W login
if ($LASTEXITCODE -ne 0) { throw 'Dang nhap Cloudflare chua xong.' }
Write-Host "`n=== 2/5 Dua ma len Cloudflare (lan dau co the hoi dat ten mien workers.dev: go 1 ten, vd timishop) ===" -ForegroundColor Cyan
npx --yes $W deploy
if ($LASTEXITCODE -ne 0) { throw 'Dua len Cloudflare loi' }
npx --yes $W deploy *> deploy_log.txt    # lan 2 chi de lay dia chi
Get-Content deploy_log.txt
$url = (Select-String -Path deploy_log.txt -Pattern 'https://[A-Za-z0-9.-]+\.workers\.dev' | Select-Object -First 1).Matches[0].Value
if (-not $url) { throw 'Khong thay dia chi workers.dev trong deploy_log.txt' }
Write-Host "Dia chi: $url"
Write-Host "`n=== 3/5 Cat khoa bi mat len Cloudflare ===" -ForegroundColor Cyan
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
$khoa = ([Convert]::ToBase64String($b) -replace '[+/=]', '')
$khoa | npx --yes $W secret put VE_KHOA
if ($LASTEXITCODE -ne 0) { throw 'Loi cat VE_KHOA' }
Get-Content $cred -Raw | npx --yes $W secret put GOOGLE_SA
if ($LASTEXITCODE -ne 0) { throw 'Loi cat GOOGLE_SA' }
Write-Host "`n=== 4/5 Noi bot quet don (Apps Script) voi may chu nhanh ===" -ForegroundColor Cyan
[IO.File]::WriteAllText("$clasp\bi_mat_ve.js", "// tao boi quet_nhanh\cai_dat.ps1 - KHONG chia se`nconst VE_KHOA = '$khoa';`nconst VE_URL = '$url';`n", (New-Object Text.UTF8Encoding $false))
Push-Location $clasp
clasp push --force
if ($LASTEXITCODE -ne 0) { Pop-Location; throw 'clasp push loi' }
clasp deploy -i AKfycbzBTUAQ1A3MIz8BlhbKHYIsQbPKV9rxjbHgOGoLSZwiaQa8KjIu756s_oZzVWt-pGc -d "2026-10-20 ghi nhanh cloudflare"
clasp deployments
Pop-Location
Write-Host "`n=== 5/5 Thu may chu ===" -ForegroundColor Cyan
try { (Invoke-WebRequest -UseBasicParsing $url).Content } catch { Write-Host $_ }
Write-Host "`nXONG. Bao Claude: 'da cai xong quet nhanh'." -ForegroundColor Green
