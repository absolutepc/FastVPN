ALTER TABLE "payments"
ADD COLUMN "appliedAt" TIMESTAMP(3),
ADD COLUMN "appliedSubscriptionId" TEXT;

CREATE INDEX "payments_appliedAt_idx"
ON "payments"("appliedAt");

UPDATE "payments"
SET "appliedAt" = COALESCE("reviewedAt", "updatedAt")
WHERE "status" = 'SUCCEEDED'
  AND "appliedAt" IS NULL;
