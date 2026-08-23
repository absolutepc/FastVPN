CREATE TYPE "BonusType" AS ENUM (
  'TELEGRAM_CHANNEL'
);

CREATE TYPE "BonusClaimStatus" AS ENUM (
  'APPLYING',
  'PENDING',
  'CONFIRMED',
  'REVOKED'
);

CREATE TABLE "bonus_claims" (
  "id" TEXT NOT NULL,

  "userId" TEXT NOT NULL,
  "subscriptionId" TEXT NOT NULL,

  "type" "BonusType" NOT NULL,
  "status" "BonusClaimStatus" NOT NULL DEFAULT 'APPLYING',

  "bonusDays" INTEGER NOT NULL DEFAULT 7,

  "channelUsername" TEXT NOT NULL,

  "baseExpiresAt" TIMESTAMP(3) NOT NULL,
  "targetExpiresAt" TIMESTAMP(3) NOT NULL,

  "grantedAt" TIMESTAMP(3),
  "confirmAfter" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),

  "syncPending" BOOLEAN NOT NULL DEFAULT false,

  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "bonus_claims_pkey"
    PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX
  "bonus_claims_userId_type_key"
ON
  "bonus_claims"("userId", "type");

CREATE INDEX
  "bonus_claims_status_confirmAfter_idx"
ON
  "bonus_claims"("status", "confirmAfter");

CREATE INDEX
  "bonus_claims_syncPending_idx"
ON
  "bonus_claims"("syncPending");

ALTER TABLE "bonus_claims"
ADD CONSTRAINT "bonus_claims_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "bonus_claims"
ADD CONSTRAINT "bonus_claims_subscriptionId_fkey"
FOREIGN KEY ("subscriptionId")
REFERENCES "subscriptions"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
