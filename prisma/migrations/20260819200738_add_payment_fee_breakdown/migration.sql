ALTER TABLE "payments"
ADD COLUMN "baseAmount" INTEGER,
ADD COLUMN "feeAmount" INTEGER,
ADD COLUMN "feePercent" INTEGER;

UPDATE "payments"
SET
  "baseAmount" = "amount",
  "feeAmount" = 0,
  "feePercent" = 0
WHERE
  "baseAmount" IS NULL
  OR "feeAmount" IS NULL
  OR "feePercent" IS NULL;
