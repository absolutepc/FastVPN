-- CreateEnum
CREATE TYPE "GiftStatus" AS ENUM (
  'PENDING_PAYMENT',
  'PAID',
  'CLAIMED',
  'CANCELLED',
  'EXPIRED'
);

-- CreateTable
CREATE TABLE "gift_subscriptions" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,

  "buyerId" TEXT NOT NULL,
  "recipientId" TEXT,
  "paymentId" TEXT,

  "plan" "PlanType" NOT NULL,
  "durationMonths" INTEGER NOT NULL,
  "days" INTEGER NOT NULL,
  "amount" INTEGER NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'RUB',

  "status" "GiftStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',

  "paidAt" TIMESTAMP(3),
  "claimedAt" TIMESTAMP(3),

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "gift_subscriptions_pkey"
    PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gift_subscriptions_token_key"
ON "gift_subscriptions"("token");

-- CreateIndex
CREATE UNIQUE INDEX "gift_subscriptions_paymentId_key"
ON "gift_subscriptions"("paymentId");

-- CreateIndex
CREATE INDEX "gift_subscriptions_buyerId_createdAt_idx"
ON "gift_subscriptions"("buyerId", "createdAt");

-- CreateIndex
CREATE INDEX "gift_subscriptions_recipientId_createdAt_idx"
ON "gift_subscriptions"("recipientId", "createdAt");

-- CreateIndex
CREATE INDEX "gift_subscriptions_status_createdAt_idx"
ON "gift_subscriptions"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "gift_subscriptions"
ADD CONSTRAINT "gift_subscriptions_buyerId_fkey"
FOREIGN KEY ("buyerId")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_subscriptions"
ADD CONSTRAINT "gift_subscriptions_recipientId_fkey"
FOREIGN KEY ("recipientId")
REFERENCES "users"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gift_subscriptions"
ADD CONSTRAINT "gift_subscriptions_paymentId_fkey"
FOREIGN KEY ("paymentId")
REFERENCES "payments"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;
