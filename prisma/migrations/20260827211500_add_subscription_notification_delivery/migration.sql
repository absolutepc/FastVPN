ALTER TABLE "notifications"
ADD COLUMN "dedupeKey" TEXT,
ADD COLUMN "telegramSentAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "notifications_dedupeKey_key"
ON "notifications"("dedupeKey");
