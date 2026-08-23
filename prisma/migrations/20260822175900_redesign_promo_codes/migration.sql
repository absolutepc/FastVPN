ALTER TABLE "promo_codes"
DROP COLUMN "discountPercent",
DROP COLUMN "discountAmount",
ADD COLUMN "plan" "PlanType" NOT NULL,
ADD COLUMN "days" INTEGER NOT NULL,
ADD COLUMN "perUserLimit" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "createdByTelegramId" BIGINT,
ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX
  "promo_codes_isActive_validUntil_idx"
ON
  "promo_codes"("isActive", "validUntil");

CREATE TABLE "promo_redemptions" (
  "id" TEXT NOT NULL,
  "promoCodeId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "plan" "PlanType" NOT NULL,
  "days" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "promo_redemptions_pkey"
    PRIMARY KEY ("id")
);

CREATE INDEX
  "promo_redemptions_promoCodeId_userId_idx"
ON
  "promo_redemptions"("promoCodeId", "userId");

CREATE INDEX
  "promo_redemptions_userId_createdAt_idx"
ON
  "promo_redemptions"("userId", "createdAt");

ALTER TABLE "promo_redemptions"
ADD CONSTRAINT
  "promo_redemptions_promoCodeId_fkey"
FOREIGN KEY ("promoCodeId")
REFERENCES "promo_codes"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "promo_redemptions"
ADD CONSTRAINT
  "promo_redemptions_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
