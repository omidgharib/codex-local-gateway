# Codex Local Gateway

یک سرویس HTTP محلی برای ارسال درخواست‌های شخصی به Codex با همان ورود رسمی Codex CLI. این پروژه از API key یا اتوماسیون مرورگر استفاده نمی‌کند.

برای اتصال عامل‌های هوش مصنوعی، فایل [`AGENTS.md`](./AGENTS.md) را در اختیار عامل قرار دهید. قرارداد ماشین‌خوان API نیز در [`openapi.yaml`](./openapi.yaml) موجود است.

داشبورد trace پس از اجرای سرویس در آدرس `http://127.0.0.1:4317/dashboard` در دسترس است. برای مشاهده داده‌ها، token محلی gateway را داخل داشبورد وارد کنید.

فونت فارسی داشبورد [Vazirmatn](https://github.com/rastikerdar/vazirmatn) است که به‌صورت محلی سرو می‌شود و تحت مجوز SIL Open Font License 1.1 در `public/fonts/OFL.txt` قرار دارد.

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

می‌توانید تنظیمات محلی را در فایل `.env.local` قرار دهید. این فایل به Git اضافه نمی‌شود و متغیرهای محیطیِ تنظیم‌شده در PowerShell همیشه بر آن اولویت دارند:

```env
LOCAL_CODEX_GATEWAY_TOKEN=یک-توکن-تصادفی-حداقل-۳۲-کاراکتری
CODEX_ALLOWED_ROOTS=C:\\Users\\Dotin\\Documents\\codex-local-gateway
CODEX_MODEL=gpt-5.6-terra
```

پس از ساخت فایل، اجرای `node src/server.mjs` آن را خودکار می‌خواند.

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

### سازگاری محدود با Responses API

مسیر `POST /v1/responses` بدنه‌ای شبیه Responses API می‌پذیرد. فیلدهای پشتیبانی‌شده `model`، `input` (رشته یا message array با `input_text`)، `instructions` و `stream: false` هستند. فیلدهای محلیِ قدیمی `mode`، `working_directory` و `include_events` نیز برقرارند. هر پارامتر دیگر، از جمله `temperature`، `tools`، `store` یا `stream: true` با خطای `400` و نام پارامتر برگردانده می‌شود؛ این گیت‌وی جایگزین API رسمی OpenAI نیست.

```json
{
  "model": "gpt-5.6-terra",
  "instructions": "Answer briefly.",
  "input": [{
    "role": "user",
    "content": [{ "type": "input_text", "text": "Say hello." }]
  }],
  "stream": false,
  "mode": "read-only"
}
```

پاسخ دارای ساختار `object: "response"`، آرایهٔ `output` و فیلد کمکی `output_text` است. زمان صف و اجرا با فیلدهای اختصاصی `queue_wait_ms` و `execution_ms` بازگردانده می‌شوند.

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

با همان Bearer token، metadata محدود traceها و خلاصه صف را برمی‌گرداند. نگهداری پیش‌فرض ۲۴ ساعت و حداکثر ۱۰۰۰ رکورد است و با `CODEX_LOG_RETENTION_MS` و `CODEX_LOG_MAX_ENTRIES` قابل تنظیم است.

### `GET /v1/logs/:requestId`

جزئیات یک trace را برمی‌گرداند. ذخیره prompt، پاسخ، eventها، stderr و مسیر کامل به‌صورت پیش‌فرض خاموش است. برای فعال‌سازی، سرویس را با `CODEX_TRACE_CONTENT=true` اجرا کنید. محتوا فقط در حافظه نگهداری می‌شود، با همان retention حذف می‌شود و پس از restart از بین می‌رود. Bearer token هیچ‌وقت داخل trace ذخیره نمی‌شود.

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
- فعال‌سازی `CODEX_TRACE_CONTENT` می‌تواند secretهای موجود در prompt یا خروجی را موقتاً در حافظه نگه دارد؛ retention را کوتاه و دسترسی به دستگاه را محدود نگه دارید.
