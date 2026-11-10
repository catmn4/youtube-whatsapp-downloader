# تشغيل apiBaileysWA عبر Pairing Code

تم تجهيز المشروع للعمل عبر Bun واستخدام **Pairing Code** بدل QR.

## 1. تثبيت وتشغيل المشروع

```bash
bun install
bun run start
```

للتطوير مع إعادة التشغيل التلقائي:

```bash
bun run dev
```

الخادم يعمل افتراضيًا على:

```text
http://127.0.0.1:3000
```

## 2. إعداد ملف البيئة

تم إنشاء ملف `.env` محليًا، وهو غير متتبع في Git. أهم القيم:

```env
PORT=3000
AUTH_GLOBAL_TOKEN=غيّره_إلى_قيمة_سرية
AUTH_STATE_BACKEND=file
```

استخدم أرقام الهاتف بصيغة دولية **من دون علامة `+` أو مسافات**، مثل:

```text
9665XXXXXXXX
```

## 3. طلب Pairing Code

ضع الرقم في ملف `.env` أولًا:

```env
SESSION_ID=whatsapp-main
PHONE_NUMBER=9665XXXXXXXX
```

ثم بعد تشغيل الخادم نفّذ:

```bash
bun run pairing
```

## التشغيل التلقائي في Wispbyte

ملف التشغيل الرئيسي الوحيد هو `src/index.js`، وهو يدير تشغيل الخادم وطلب Pairing Code مباشرة.

```text
MAIN_FILE=src/index.js
```

سيبدأ هذا الملف خادم API، ينتظر جاهزيته، ثم يطلب Pairing Code تلقائيًا من القيم الموجودة في `.env`.

لا تحتاج إلى تشغيل `scripts/pairing-code.ts` يدويًا عند استخدام Wispbyte.

السكربت يستدعي:

```http
POST /sessions/whatsapp-main
Authorization: Bearer <AUTH_GLOBAL_TOKEN>
Content-Type: application/json
```

ويرسل:

```json
{
  "usePairingCode": true,
  "phoneNumber": "9665XXXXXXXX",
  "freshAuth": false
}
```

يمكن أيضًا استخدام متغيرات البيئة بدل الوسائط:

```bash
SESSION_ID=whatsapp-main PHONE_NUMBER=9665XXXXXXXX bun run pairing
```

## 4. إدخال الكود في الهاتف

في الهاتف المرتبط بالرقم:

1. افتح WhatsApp.
2. اذهب إلى **الإعدادات**.
3. اختر **الأجهزة المرتبطة**.
4. اختر **ربط جهاز**.
5. اختر **الربط باستخدام رقم الهاتف بدلًا من ذلك**.
6. أدخل الكود الذي ظهر في الطرفية.

بعد نجاح الربط، تُحفظ بيانات الجلسة في مجلد `sessions/` ويعيد الخادم الاتصال بها تلقائيًا عند التشغيل التالي.

## إعادة إنشاء جلسة جديدة

إذا كانت الجلسة القديمة تالفة أو تريد ربطها من جديد، استخدم:

```bash
FRESH_AUTH=true bun run pairing
```

هذا يحذف بيانات اعتماد الجلسة الحالية، لذلك لا تستخدمه لجلسة تعمل بالفعل إلا إذا كنت تقصد فك ربطها وإعادة ربطها.

## التحقق من الحالة

```bash
curl -H "Authorization: Bearer $AUTH_GLOBAL_TOKEN" \
  http://127.0.0.1:3000/sessions/whatsapp-main
```

وفحص الخادم العام:

```bash
curl http://127.0.0.1:3000/status
```

## ملاحظات أمنية

- لا تشارك `AUTH_GLOBAL_TOKEN` أو ملفات مجلد `sessions/`.
- لا تستخدم أرقامًا عشوائية؛ يجب أن يكون الرقم مسجلًا على WhatsApp.
- pairing code يربط حساب WhatsApp فعليًا بعميل Baileys غير رسمي؛ استخدمه بمعدلات إرسال منخفضة وتجنب الرسائل الجماعية غير المرغوبة.
