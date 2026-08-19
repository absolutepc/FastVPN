ALTER TABLE "payments"
RENAME COLUMN "yookassaPaymentId" TO "providerPaymentId";

ALTER INDEX "payments_yookassaPaymentId_key"
RENAME TO "payments_providerPaymentId_key";

ALTER TABLE "payments"
ADD COLUMN "paymentProvider" TEXT;

UPDATE "payments"
SET "paymentProvider" = 'YOOKASSA'
WHERE "providerPaymentId" IS NOT NULL
  AND "paymentProvider" IS NULL;

UPDATE "payments"
SET "paymentProvider" = 'MANUAL'
WHERE "paymentMethod" = 'MANUAL_SBP'
  AND "paymentProvider" IS NULL;
