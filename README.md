# Codex Local Gateway

یک سرویس HTTP محلی برای ارسال درخواست‌های شخصی به Codex با همان ورود رسمی Codex CLI. این پروژه از API key یا اتوماسیون مرورگر استفاده نمی‌کند.

برای اتصال عامل‌های هوش مصنوعی، فایل [`AGENTS.md`](./AGENTS.md) را در اختیار عامل قرار دهید. قرارداد ماشین‌خوان API نیز در [`openapi.yaml`](./openapi.yaml) موجود است.

داشبورد trace پس از اجرای سرویس در آدرس `http://127.0.0.1:4317/dashboard` در دسترس است. برای مشاهده داده‌ها، token محلی gateway را داخل داشبورد وارد کنید.

## پیش‌نیازها

- Node.js 20 یا جدیدتر
- Codex CLI
- ورود موفق Codex با حساب ChatGPT خودتان

ابتدا وضعیت ورود را بررسی کنید:

```powershell
codex login status
```

اگر وارد نشده‌اید:

```powershell
codex login
```

## راه‌اندازی در PowerShell

به پوشه پروژه بروید و یک token محلی بسازید:

```powershell
$env:LOCAL_CODEX_GATEWAY_TOKEN = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$env:CODEX_ALLOWED_ROOTS = (Get-Location).Path
$env:CODEX_BIN = "C:\Users\Dotin\AppData\Local\OpenAI\Codex\bin\247581e40ee272fb\codex.exe"
$env:CODEX_HOME = "C:\Users\Dotin\.codex"
node src/server.mjs
```

این مقدار token را فقط در همان نشست PowerShell یا secret manager نگهداری کنید؛ آن را در Git قرار ندهید.

## ارسال درخواست

در PowerShell دیگری همان token را در متغیر محیطی قرار دهید و اجرا کنید:

```powershell
$headers = @{ Authorization = "Bearer $env:LOCAL_CODEX_GATEWAY_TOKEN" }
$body = @{
  input = "این پروژه را بررسی کن و سه ریسک اصلی را توضیح بده"
  mode = "read-only"
  working_directory = "C:\path\to\your\project"
} | ConvertTo-Json

Invoke-RestMethod `
  -Uri "http://127.0.0.1:4317/v1/responses" `
  -Method Post `
  -Headers $headers `
  -ContentType "application/json" `
  -Body $body
```

پاسخ اصلی در فیلد `output_text` قرار دارد.

## قرارداد HTTP

### `GET /health`

وضعیت سرویس و طول صف را برمی‌گرداند. این endpoint اطلاعات حساس ندارد.

### `POST /v1/responses`

Header:

```text
Authorization: Bearer <LOCAL_CODEX_GATEWAY_TOKEN>
```

Body:

```json
{
  "input": "درخواست",
  "working_directory": "C:\\path\\to\\project",
  "mode": "read-only",
  "include_events": false
}
```

- حالت پیش‌فرض `read-only` است.
- برای فعال‌کردن تغییر فایل‌ها، ابتدا `CODEX_ALLOW_WRITES=true` تنظیم کنید و در درخواست `mode: workspace-write` بفرستید.
- پوشه کاری باید داخل یکی از مسیرهای `CODEX_ALLOWED_ROOTS` باشد.
- درخواست‌ها به‌صورت پیش‌فرض یکی‌یکی اجرا می‌شوند تا مصرف و تداخل کنترل شود.

### `GET /v1/logs`

با همان Bearer token، metadata محدود traceها و خلاصه صف را برمی‌گرداند. متن prompt، پاسخ و token ذخیره نمی‌شوند. نگهداری پیش‌فرض ۲۴ ساعت و حداکثر ۱۰۰۰ رکورد است و با `CODEX_LOG_RETENTION_MS` و `CODEX_LOG_MAX_ENTRIES` قابل تنظیم است.

## تست

```powershell
node --test
```

## محدودیت‌های آگاهانه

- سرویس فقط روی `127.0.0.1` گوش می‌دهد؛ آن را مستقیماً روی اینترنت منتشر نکنید.
- نسخه اول پاسخ را پس از پایان کار برمی‌گرداند و streaming HTTP ندارد.
- هر فراخوانی یک اجرای ephemeral جدید است و حافظه مکالمه ندارد.
- محدودیت مصرف و دسترسی مدل تابع حساب Codex شماست.
- این gateway برای استفاده شخصی و کم‌هم‌زمانی طراحی شده است.
