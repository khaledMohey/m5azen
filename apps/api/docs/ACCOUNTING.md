# موديول الحسابات — دليل الاستخدام

## نظرة عامة

طبقة محاسبية مزدوجة القيد فوق النظام التشغيلي الحالي (مبيعات، مشتريات، خزنة، مصروفات) دون استبدال أرصدة العملاء/الموردين/الخزائن التشغيلية.

- الواجهة: `/accounting`
- API: `/api/accounting`
- صلاحية الصفحة: `accounting` (عرض، إنشاء، تعديل، ترحيل، إلغاء، تصدير)

## الإعداد الأولي

1. تأكد أن قاعدة التطوير محلية (`DATABASE_URL=file:./dev.db`) وأن `TURSO_DATABASE_URL` غير مفعّل عند التجربة.
2. من حساب **ADMIN**: `POST /api/accounting/seed` لإنشاء دليل الحسابات الافتراضي والربط المحاسبي.
3. اربط حسابات الخزنة التشغيلية بحسابات الدليل عبر `Account.cashAccountId` عند الحاجة للترحيل الديناميكي.

## الافتراضات

- ضريبة المشتريات في المرحلة الحالية **قابلة للاسترداد بالكامل** → حساب `1400`.
- خصم المبيعات/المشتريات بطريقة **Net** (لا قيد خصم منفصل مع صافي الإيراد/المخزون).
- التقارير تشمل `POSTED` و`REVERSED` وتستبعد `DRAFT`.

## التدفقات الأساسية

| عملية تشغيلية | حدث محاسبي | المصدر |
|---------------|------------|--------|
| تأكيد فاتورة بيع | `SALE_CONFIRM` ثم `SALE_RECEIPT` لكل إيصال | بعد `recostProducts` |
| تأكيد فاتورة شراء | `PURCHASE_CONFIRM` ثم `PURCHASE_PAYMENT` لكل دفعة | بعد التأكيد |
| سند قبض مستقل | `SALE_RECEIPT` | `CashService.createReceipt` |
| سند صرف | `PURCHASE_PAYMENT` | `CashService.createPayment` |
| مصروف | `EXPENSE_CREATE` | `FinanceService` |
| اعتماد كشف مرتبات | `PAYROLL_POST` | استحقاق: 5210/5220 ← 2300 (بدون نقد) |
| صرف كشف مرتبات | `PAYROLL_PAYMENT` | 2300 ← نقد/بنك + حركة خزنة تشغيلية |
| تغيّر FIFO بعد البيع | `SALE_COGS_ADJUST` عبر الطابور | Dirty + Sweep |

> **ملاحظة رواتب:** الحساب `2200` يبقى ضريبة مبيعات. مستحقات الرواتب على **`2300`**. الاعتماد لا ينشئ مصروفًا عبر المالية (منع الازدواج). الدفع الجزئي غير مدعوم.
>
> **صرف آمن:** `pay` يعمل `updateMany` شرطي (`POSTED` + `paidAmount=0`) ثم حركة خزنة OUT ثم outbox `PAYROLL_PAYMENT` في **نفس المعاملة**. عكس الاستحقاق مرفوض والكشف مدفوع؛ عكس الصرف عبر `POST .../reverse-payment` (قيد + حركة IN مطابقة) ثم `.../reverse` للاستحقاق.

عند فشل الترحيل الفوري تُضاف المهمة إلى `AccountingPostQueue` دون التراجع عن العملية التشغيلية.
معالجة الطابور: `POST /api/accounting/queue/process` أو `POST /api/accounting/cogs/sweep`.

## FIFO وCOGS

- تذاكر `FifoReplayEpoch` قبل الحساب؛ بوابة نشر تتطلب `nextSeq == ticket` و`lastPublishedSeq < ticket`.
- نشر ذري للتكلفة + `SalesInvoice.cogsEpoch` + `AccountingCogsDirty`.
- قفل `AccountingCogsLock.lockVersion` + `AccountingPostQueue.claimVersion` عند الترحيل.

## الأرصدة الافتتاحية

- دفعات `AccountOpeningBatch` بإصدارات؛ دفعة `APPLIED` واحدة لكل سنة (`appliedYearKey`).
- AR/AP: سطور أطراف فقط (بدون سطر NONE مزدوج على حساب التحكم).

## التصنيع (Phase 6)

لا يوجد موديول إنتاج فعلي في المشروع. أحداث `MFG_*` محجوزة في الـ enum فقط وغير مفعّلة في المعالج.

## الاختبار

استخدم قاعدة منفصلة `prisma/accounting-test.db` — لا تشغّل الاختبارات على بيانات المستخدم:

```bash
cd apps/api
npx tsc -p tsconfig.json --noEmit
$env:TURSO_DATABASE_URL=''; $env:DATABASE_URL='file:./prisma/accounting-test.db'
npx tsx --test --test-concurrency=1 src/accounting/accounting.money.spec.ts test/accounting-e2e.test.ts test/accounting-audit.test.ts
```

مرتجعات المبيعات/المشتريات تُرحَّل عبر `SALE_RETURN` / `PURCHASE_RETURN`.
إقفال السنة: `POST /accounting/closing/close` مع `{ year }`.
تقارير إضافية: cash-flow، tax، ar، ap، cost-centers، **reconciliation** (`GET /api/accounting/reports/reconciliation` — قراءة فقط، لا يعدّل أرصدة).

## حدود معروفة (تدقيق الإصدار)

- طبقتان: أرصدة تشغيلية (`Customer`/`Supplier`/`CashAccount`) وGL منفصلتان؛ الفروق متوقعة حتى اكتمال الترحيل التاريخي وربط `cashAccountId`.
- مرتجع المبيعات التشغيلي قد يمثل خردة/استهلاك وليس إشعار دائن تقليدي للعميل.
- قائمة التدفقات وإقفال السنة مبسّطان من قيود GL.
- التزامن متعدد العمال على Turso **غير مُختبَر** على SQLite المحلي.
- لا تصنيع / WIP / BOM.

## النسخ الاحتياطي قبل Schema

تم أخذ نسخة قبل التطبيق والتدقيق:

- `apps/api/backups/m5azen-pre-accounting-*.db`
- `apps/api/backups/accounting-test-pre-audit-2026-11-21T19-28-14.db`
