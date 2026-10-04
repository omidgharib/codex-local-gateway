# نصب و راه‌اندازی Codex Local Gateway

این پروژه یک سرویس محلی است که درخواست‌های HTTP را از طریق Codex CLI و حساب واردشدهٔ خود شما اجرا می‌کند. هر کاربر باید سرویس و ورود Codex خودش را داشته باشد. برای این روش کلید OpenAI API یا کوکی مرورگر لازم نیست.

مسیر اصلی این راهنما ویندوز و PowerShell است. مراحل macOS/Linux و Docker در انتها آمده‌اند.

## ۱. پیش‌نیازها

- Node.js نسخهٔ ۲۰ یا بالاتر، همراه npm؛ از [وب‌سایت Node.js](https://nodejs.org/en/download) نصب کنید.
- Git برای دریافت پروژه؛ از [وب‌سایت Git](https://git-scm.com/downloads) نصب کنید. دریافت ZIP مخزن هم ممکن است.
- حسابی که امکان استفاده از Codex را دارد و اتصال اینترنت برای ورود و اجرای درخواست‌ها.
- PowerShell و مرورگر برای مشاهدهٔ داشبورد.

پس از نصب، یک پنجرهٔ تازهٔ PowerShell باز کنید:

```powershell
node --version
npm.cmd --version
git --version
```

اگر فرمان پیدا نمی‌شود، ابتدا ترمینال را ببندید و دوباره باز کنید؛ سپس نصب و PATH را بررسی کنید. در ویندوز از `npm.cmd` استفاده می‌کنیم تا اجرای npm به سیاست اجرای فایل‌های PowerShell وابسته نباشد.

## ۲. دریافت پروژه

در پوشه‌ای که می‌خواهید پروژه قرار بگیرد اجرا کنید:

```powershell
git clone https://github.com/omidgharib/codex-local-gateway.git
Set-Location -LiteralPath .\codex-local-gateway
```

اگر ZIP گرفته‌اید، آن را استخراج کنید و PowerShell را در پوشه‌ای باز کنید که `package.json` و `src` داخل آن هستند. این پروژه در حال حاضر وابستگی npm ندارد؛ برای اجرای خود درگاه نیازی به `npm install` نیست.

## ۳. نصب Codex و ورود به حساب

نصب رسمی با npm:

```powershell
npm.cmd install --global @openai/codex
codex --version
codex login
codex login status
```

مراحل ورود را با حساب خودتان تکمیل کنید. نصب و ورود باید با همان کاربر سیستم‌عاملی انجام شود که درگاه را اجرا می‌کند. برای جزئیات نصب به [مخزن رسمی Codex](https://github.com/openai/codex#installation) مراجعه کنید.

قبل از راه‌اندازی درگاه، یک اجرای واقعی و بدون تغییر فایل را بررسی کنید:

```powershell
codex exec --skip-git-repo-check --sandbox read-only "Reply with exactly: CODEX_OK"
```

باید پاسخ `CODEX_OK` دریافت کنید. اگر ورود، دسترسی حساب یا اتصال شبکه مشکل دارد، ابتدا همین اجرای مستقیم را درست کنید. نصب برنامهٔ دسکتاپ به‌تنهایی تضمین نمی‌کند فرمان Codex در PATH سرویس موجود باشد.

## ۴. ساخت تنظیمات محلی و توکن

از ریشهٔ پروژه اجرا کنید. اگر قبلاً `.env.local` ساخته‌اید، آن را بازنویسی نکنید:

```powershell
if (Test-Path -LiteralPath .env.local) { throw '.env.local already exists; edit it instead.' }
Copy-Item -LiteralPath env.example -Destination .env.local
$gatewayToken = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
if ($LASTEXITCODE -ne 0 -or $gatewayToken.Length -ne 64) { throw 'Token generation failed' }
$gatewayConfigPath = Join-Path (Get-Location).Path '.env.local'
$gatewayConfig = [IO.File]::ReadAllText($gatewayConfigPath)
$gatewayConfig = $gatewayConfig.Replace('replace-with-a-long-random-token', $gatewayToken)
[IO.File]::WriteAllText($gatewayConfigPath, $gatewayConfig)
Remove-Variable gatewayToken, gatewayConfig
notepad .env.local
```

توکن ساخته‌شده فقط برای احراز هویت **درگاه محلی** است؛ کلید OpenAI نیست. آن را در مخزن، URL، عکس، پیام یا پرامپت مدل قرار ندهید. `.env.local` در Git نادیده گرفته می‌شود. برای انتقال پروژه به سیستم دیگر یک توکن جدید بسازید و فایل ورود Codex کاربر دیگر را کپی نکنید.

برای شروع، این تنظیمات کافی هستند؛ مقدار توکن تولیدشده را نگه دارید:

```env
HOST=127.0.0.1
PORT=4317
CODEX_BIN=codex
CODEX_HOME=
CODEX_ALLOWED_ROOTS=
CODEX_MODEL=
CODEX_ALLOW_WRITES=false
CODEX_TRACE_CONTENT=false
```

- `CODEX_ALLOWED_ROOTS` خالی: فقط پوشه‌ای که سرویس از آن شروع شده مجاز است. برای پروژهٔ دیگر، مسیر مطلق آن را بنویسید؛ مثلاً `C:\Users\you\Documents\my-project`. چند مسیر در ویندوز با `;` و در macOS/Linux با `:` جدا می‌شوند.
- `CODEX_HOME` خالی: پوشهٔ `.codex` کاربر جاری استفاده می‌شود. اگر ورود شما در محل دیگری است، همان مسیر را مشخص کنید.
- `CODEX_MODEL` خالی: مدل پیش‌فرض Codex استفاده می‌شود. انتخاب مدل را پس از دریافت `/v1/models` انجام دهید.
- `CODEX_ALLOW_WRITES=false`: برای شروع نگه دارید. برای تغییر فایل، هم این گزینه باید `true` باشد و هم درخواست `mode: "workspace-write"` داشته باشد و کاربر تغییر را مجاز کرده باشد.
- `CODEX_TRACE_CONTENT=true`: اختیاری، برای مشاهدهٔ متن ورودی، پاسخ و جزئیات در داشبورد. این اطلاعات ممکن است حساس باشند. با مقدار `false` هم اطلاعات کلی درخواست‌ها ثبت می‌شود.

متغیرهای محیطی موجود بر `.env.local` اولویت دارند. پس از هر تغییر تنظیمات، سرویس را متوقف و دوباره اجرا کنید.

### مسیر Codex در ویندوز

برای نصب دسکتاپ ویندوز، `CODEX_BIN` را حذف کنید یا روی `codex` بگذارید. درگاه در هر اجرا جدیدترین فایل اجرایی موجود در `%LOCALAPPDATA%\OpenAI\Codex\bin` را پیدا می‌کند؛ بنابراین تغییر پوشه پس از آپدیت نیاز به تنظیم مجدد ندارد. مسیر صریح در `CODEX_BIN` بر تشخیص خودکار اولویت دارد. اگر نصب دسکتاپ پیدا نشود، درگاه از `PATH` استفاده می‌کند. برای بررسی نصب‌های دیگر:

```powershell
Get-Command codex* | Select-Object Name, Source
```

برای انتخاب دستی یک `codex.exe` خاص می‌توانید مقدار کامل `Source` را در `CODEX_BIN` قرار دهید. اگر نصب npm فقط `codex.cmd` یا `codex.ps1` را نشان می‌دهد، می‌توانید بستهٔ npm را مستقیماً با Node اجرا کنید:

```powershell
$gatewayNodePath = (Get-Command node.exe).Source
$gatewayNpmRoot = npm.cmd root --global
$gatewayCliPath = Join-Path $gatewayNpmRoot '@openai\codex\bin\codex.js'
if (-not (Test-Path -LiteralPath $gatewayCliPath)) { throw 'Codex npm entry point was not found' }
$gatewayNodePath
ConvertTo-Json -InputObject @($gatewayCliPath) -Compress
```

این دو خروجی محرمانه نیستند. خروجی اول را در `CODEX_BIN` و خروجی JSON دوم را در `CODEX_BIN_ARGS` بگذارید:

```env
CODEX_BIN=C:\absolute\path\to\node.exe
CODEX_BIN_ARGS=["C:\\absolute\\path\\to\\@openai\\codex\\bin\\codex.js"]
```

مسیر داخل آرایه JSON باید بک‌اسلش‌های escape‌شده داشته باشد؛ خروجی `ConvertTo-Json` این کار را انجام می‌دهد. مسیر عادی `CODEX_BIN` در فایل env بک‌اسلش تکی دارد.

## ۵. اجرای سرویس

سرویس را در PowerShell معمولی با حساب خودتان، خارج از محیط محدود عامل Codex اجرا کنید. فرایند Codex باید بتواند در `CODEX_HOME` (پیش‌فرض: پوشهٔ `.codex` کاربر) اطلاعات داخلی و فایل‌های موقت بنویسد؛ این نیاز حتی برای درخواست `read-only` وجود دارد. معمولاً اجرای Administrator لازم نیست.

از ریشهٔ پروژه:

```powershell
node src/server.mjs
```

این پنجره را باز نگه دارید. پیام شروع سرویس باید آدرس محلی را نشان دهد. برای توقف، `Ctrl+C` بزنید. اجرای `npm.cmd start` هم معادل همین دستور است.

در پنجرهٔ دوم، سلامت سرویس را بررسی کنید:

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:4317/health'
```

انتظار: `status` برابر `ok`. این فقط سلامت درگاه را ثابت می‌کند؛ تست واقعی مرحلهٔ بعد ورود و اجرای Codex را هم بررسی می‌کند.

اگر `/health` صفحهٔ HTML برنامه را برگرداند، پورت مقصد متعلق به درگاه نیست. برنامه و درگاه باید پورت‌های جدا داشته باشند. مثلاً اگر برنامه روی ۴۳۱۷ است، `PORT=14317` را برای درگاه تنظیم کنید و آدرس درگاه در تنظیمات سمت سرور برنامه را `http://127.0.0.1:14317` بگذارید. در تمام آدرس‌های سلامت، مدل‌ها، درخواست و داشبورد این راهنما نیز پورت انتخاب‌شده را جایگزین کنید. توکن را در سمت سرور نگه دارید.

## ۶. درخواست واقعی روی سرویس اصلی

پنجرهٔ دوم را نیز در ریشهٔ پروژه باز کنید. قطعهٔ زیر توکن را بدون نمایش از فایل می‌خواند؛ برای فایل تولیدشده در مرحلهٔ ۴ مناسب است:

```powershell
$gatewayTokenLine = Get-Content -LiteralPath .env.local | Where-Object { $_ -match '^LOCAL_CODEX_GATEWAY_TOKEN=' } | Select-Object -First 1
if (-not $gatewayTokenLine) { throw 'Local token is missing' }
$env:LOCAL_CODEX_GATEWAY_TOKEN = ($gatewayTokenLine -split '=', 2)[1].Trim()
Remove-Variable gatewayTokenLine
$gatewayHeaders = @{ Authorization = "Bearer $env:LOCAL_CODEX_GATEWAY_TOKEN" }
$gatewayModels = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/v1/models' -Headers $gatewayHeaders -TimeoutSec 30
$gatewayModels.data | Select-Object id, display_name, is_default
$gatewayBody = @{
  input = 'Reply with exactly: GATEWAY_OK'
  mode = 'read-only'
} | ConvertTo-Json
$gatewayResponse = Invoke-RestMethod -Uri 'http://127.0.0.1:4317/v1/responses' -Method Post -Headers $gatewayHeaders -ContentType 'application/json' -Body $gatewayBody -TimeoutSec 310
if ([string]::IsNullOrWhiteSpace($gatewayResponse.output_text)) { throw 'No final output was returned' }
$gatewayResponse | Select-Object id, output_text, execution_ms
```

انتظار: یک شناسهٔ درخواست و پاسخ `GATEWAY_OK`. فهرست مدل‌ها به‌تنهایی تضمین دسترسی به مدل نیست؛ اجرای موفق درخواست معیار نهایی است. توکن پنجرهٔ دوم باید با توکن استفاده‌شده توسط سرویس یکسان باشد. اگر سرویس با یک متغیر محیطی متفاوت شروع شده، باید همان مقدار را از مسیر امن به کلاینت بدهید.

### تست ابزار روی همین داشبورد

در همان پنجرهٔ دوم که توکن در آن تنظیم شده اجرا کنید:

```powershell
.\scripts\example-tool-calling.ps1 -GatewayUrl 'http://127.0.0.1:4317'
```

این نمونه برای آب‌وهوای واقعی از Open-Meteo استفاده می‌کند و علاوه بر دسترسی Codex، اتصال به سرویس آب‌وهوا نیاز دارد. درگاه درخواست ابزار را برمی‌گرداند، اسکریپت تابع مجاز خودش را اجرا می‌کند و نتیجه را برای پاسخ نهایی می‌فرستد. درخواست‌ها در داشبورد پورت ۴۳۱۷ دیده می‌شوند.

تست جداگانهٔ زیر هم وجود دارد:

```powershell
node scripts/smoke-tool-calling.mjs
```

این تست یک **سرویس موقت روی پورت تصادفی** می‌سازد و در پایان آن را می‌بندد. مقدار دمای ۲۳ درجه در آن دادهٔ آزمایشی است. خروجی `ok: true` موفقیت را نشان می‌دهد، اما درخواست‌هایش در داشبورد سرویس اصلی ۴۳۱۷ دیده نمی‌شوند.

## ۷. داشبورد و گزارش درخواست‌ها

در مرورگر [داشبورد محلی](http://127.0.0.1:4317/dashboard) را باز کنید. مقدار `LOCAL_CODEX_GATEWAY_TOKEN` را فقط در کادر رمز داشبورد وارد کنید و اتصال/بارگذاری را انجام دهید. توکن در حافظهٔ همان نشست مرورگر نگه داشته می‌شود.

درخواست مرحلهٔ ۶ باید با شناسه‌اش قابل مشاهده باشد. برای دیدن متن کامل، `CODEX_TRACE_CONTENT=true` را در `.env.local` تنظیم کنید، سرویس را دوباره اجرا کنید و **درخواست جدید** بفرستید. این تنظیم محتوای درخواست‌های قبلی را بازیابی نمی‌کند. محتوا در حافظه است و با restart از بین می‌رود؛ `CODEX_TRACE_FILE` فقط فراداده را پایدار می‌کند.

اگر ردیفی دیده نمی‌شود، آدرس و پورت کلاینت، توکن، فیلترهای داشبورد و استفاده‌نکردن از تست موقت را بررسی کنید. پس از restart ممکن است تاریخچهٔ حافظه‌ای قبلی خالی باشد.

## ۸. اجرای خودکار در ویندوز (اختیاری)

اول اجرای دستی و تست واقعی را کامل کنید. از ریشهٔ پروژه:

```powershell
.\scripts\install-windows-startup.ps1
```

این دستور یک Scheduled Task با نام `CodexLocalGateway` برای ورود کاربر جاری ثبت می‌کند. با ورود بعدی اجرا می‌شود. اگر می‌خواهید همین حالا شروع شود، ابتدا سرویس دستی را با `Ctrl+C` متوقف کنید، سپس:

```powershell
Start-ScheduledTask -TaskName CodexLocalGateway
```

Node باید در PATH این کاربر در دسترس باشد؛ برای Codex بهتر است مسیر مطلق بخش ۴ را استفاده کنید. پس از نصب Node یا تغییر PATH ممکن است خروج و ورود مجدد به ویندوز لازم باشد. نتیجه را با `/health` و یک درخواست واقعی بررسی کنید.

برای توقف و حذف اجرای خودکار:

```powershell
Stop-ScheduledTask -TaskName CodexLocalGateway
.\scripts\uninstall-windows-startup.ps1
```

اگر ثبت task به‌علت مجوزهای سیستم رد شد، پیام خطا را بررسی کنید؛ اجرای دستی همچنان قابل استفاده است. اگر اجرای اسکریپت‌های خود پروژه با ExecutionPolicy مسدود شد، برای یک اجرای مشخص از `powershell.exe -ExecutionPolicy Bypass -File .\scripts\install-windows-startup.ps1` استفاده کنید؛ سیاست سراسری سیستم را تغییر ندهید.

## ۹. خطاهای رایج

| مشکل | بررسی و راه‌حل |
| --- | --- |
| `node` یا `npm` پیدا نمی‌شود | نصب Node و PATH را بررسی کنید و ترمینال تازه باز کنید؛ در ویندوز `npm.cmd` را امتحان کنید. |
| `spawn codex ENOENT` / خطای 503 | مسیر اجرای Codex بخش ۴ را تنظیم کنید و سرویس را restart کنید. موفقیت در ترمینال دیگر به‌معنای PATH یکسان نیست. |
| `Could not find home directory` | سرویس را با حساب واقعی کاربر اجرا کنید؛ `USERPROFILE` در ویندوز یا `HOME` در Unix باید صحیح باشد. `CODEX_HOME` را به پوشهٔ ورود همان کاربر تنظیم کنید. |
| خطای 401 | توکن کلاینت و سرویس متفاوت یا خالی است. متغیر محیطی ممکن است مقدار فایل را override کرده باشد. |
| خطای 502 | `codex login status` و تست مستقیم بخش ۳ را بررسی کنید. شناسهٔ درخواست و جزئیات خطا/diagnostics را بخوانید؛ پس از اصلاح دوباره تست کنید. |
| خطای 502 با `Access is denied` یا `attempt to write a readonly database` | فرایند درگاه به `CODEX_HOME` دسترسی نوشتن ندارد. همان درگاه را متوقف و با همان پورت و تنظیمات در PowerShell معمولی خارج از محیط محدود عامل اجرا کنید؛ سپس `/v1/models` و درخواست واقعی مرحلهٔ ۶ را آزمایش کنید. فعال کردن `workspace-write` این مشکل اطلاعات داخلی Codex را حل نمی‌کند. |
| خطای 400 برای مسیر | `working_directory` باید مطلق و داخل `CODEX_ALLOWED_ROOTS` باشد؛ تنظیمات جدید نیاز به restart دارند. |
| خطای 403 | تغییر فایل غیرفعال است؛ از read-only استفاده کنید یا برای تغییر مجاز، `CODEX_ALLOW_WRITES=true` بگذارید و restart کنید. |
| `EADDRINUSE` | پورت ۴۳۱۷ قبلاً اشغال است؛ نمونهٔ دوم را اجرا نکنید. سرویس متعلق به خودتان را متوقف کنید یا `PORT` و آدرس کلاینت را هماهنگ تغییر دهید. |
| خطای 504 | کار را ساده‌تر کنید یا `CODEX_TIMEOUT_MS` را افزایش دهید؛ timeout کلاینت باید از آن بیشتر باشد. |
| داشبورد بدون متن یا ردیف | توکن، سرویس/پورت مقصد و بخش ۷ را بررسی کنید؛ smoke test از سرویس موقت استفاده می‌کند. |

در گزارش خطا، `x-request-id` یا `error.request_id` را نگه دارید و توکن را حذف کنید. خطاهای ورود و اعتبارسنجی را بدون اصلاح درخواست پشت سر هم تکرار نکنید.

## ۱۰. macOS و Linux

Node.js 20+ و Git نصب کنید، سپس پروژه و Codex را دریافت کنید:

```sh
git clone https://github.com/omidgharib/codex-local-gateway.git
cd codex-local-gateway
npm install --global @openai/codex
codex login
codex login status
codex exec --skip-git-repo-check --sandbox read-only 'Reply with exactly: CODEX_OK'
```

برای ساخت فایل جدید، این قطعه در صورت وجود فایل متوقف می‌شود و توکن را چاپ نمی‌کند:

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const template = readFileSync('env.example', 'utf8');
writeFileSync('.env.local', template.replace('replace-with-a-long-random-token', randomBytes(32).toString('hex')), { flag: 'wx', mode: 0o600 });
JS
```

فایل را با ویرایشگر خود تنظیم کنید؛ `CODEX_BIN` در صورت نیاز خروجی `command -v codex` است. مسیرهای مجاز با `:` جدا می‌شوند. سرویس را با `node src/server.mjs` اجرا کنید. در پنجرهٔ دوم `curl http://127.0.0.1:4317/health` سلامت را بررسی می‌کند. برای درخواست احرازشده، نمونهٔ JavaScript در README را با توکن محیطی خود استفاده کنید؛ داشبورد همان آدرس بخش ۷ است. اسکریپت‌های `.ps1` و Scheduled Task مخصوص ویندوز هستند؛ نمونهٔ `node scripts/smoke-tool-calling.mjs` در این محیط‌ها هم سرویس موقت می‌سازد.

## ۱۱. Docker (اختیاری)

برای شروع معمولاً اجرای مستقیم ساده‌تر است. اگر Docker دارید، به `.env.local` و پوشهٔ ورود معتبر Codex نیاز دارید. در PowerShell:

```powershell
$env:CODEX_WORKSPACE = (Get-Location).Path
$env:CODEX_HOST_HOME = Join-Path $env:USERPROFILE '.codex'
docker compose up --build -d
docker compose logs --tail 100 gateway
```

سرویس دستی روی پورت ۴۳۱۷ را قبل از اجرای Docker متوقف کنید. Compose مسیر workspace را داخل کانتینر به `/workspace` تبدیل می‌کند؛ درخواست‌های کانتینری باید `working_directory: "/workspace"` یا مسیر زیر آن را استفاده کنند. تنظیمات `CODEX_BIN` و `CODEX_HOME` ویندوزی در Compose با مسیرهای کانتینر جایگزین می‌شوند.

پوشهٔ `.codex` میزبان باید برای کاربر کانتینر قابل دسترسی باشد. اگر روش ذخیرهٔ ورود میزبان به credential store سیستم وابسته باشد، صرف mount پوشه تضمین ورود داخل کانتینر نیست؛ ابتدا ورود را با `docker compose exec gateway codex login status` بررسی کنید و در صورت نیاز با `docker compose exec gateway codex login` ورود رسمی را تکمیل کنید. تغییرات این پوشهٔ mount‌شده روی میزبان هم اعمال می‌شوند. سپس تست واقعی HTTP مرحلهٔ ۶ را اجرا کنید.

برای توقف: `docker compose down`. برای نسخهٔ ثابت Codex، قبل از build مقدار مشخص `CODEX_VERSION` را در محیط قرار دهید؛ مقدار پیش‌فرض Dockerfile `latest` است.

## ۱۲. نگهداری و معیار آماده‌بودن

برای بررسی کد پروژه بدون فراخوانی واقعی مدل، از ریشه `node --test` اجرا کنید. این تست‌ها جای تست احرازشدهٔ مرحلهٔ ۶ را نمی‌گیرند. برای به‌روزرسانی، تغییرات محلی را حفظ کنید، نسخهٔ جدید مخزن و Codex را دریافت کنید، سرویس را restart و تست واقعی را تکرار کنید. با `CODEX_BIN=codex` مسیر نصب دسکتاپ ویندوز خودکار پیدا می‌شود؛ اگر مسیر صریح تنظیم کرده‌اید، پس از آپدیت معتبر بودن آن را بررسی کنید.

نصب زمانی کامل است که `/health` سالم باشد، `/v1/models` پاسخ بدهد، یک درخواست واقعی پاسخ غیرخالی بدهد و شناسهٔ آن در داشبورد **همان سرویس** دیده شود. درگاه را روی localhost نگه دارید و آن را مستقیم در اینترنت منتشر نکنید.

برای قرارداد API و نمونه‌های کلاینت به [README](../README.md)، برای اتصال توسط عامل کدنویسی به [INTEGRATION_PROMPT.md](../INTEGRATION_PROMPT.md) و برای schema دقیق به [openapi.yaml](../openapi.yaml) مراجعه کنید.
