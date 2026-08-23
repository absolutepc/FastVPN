CREATE TABLE "referral_rewards" (
    "id" TEXT NOT NULL,
    "inviteeId" TEXT NOT NULL,
    "referrerId" TEXT NOT NULL,
    "inviteeTrial" BOOLEAN,
    "referrerBonus" BOOLEAN,
    "inviteeSubscriptionId" TEXT,
    "referrerSubscriptionId" TEXT,
    "inviteeSyncPending" BOOLEAN NOT NULL DEFAULT false,
    "referrerSyncPending" BOOLEAN NOT NULL DEFAULT false,
    "appliedAt" TIMESTAMP(3),
    "legacyBackfilled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_rewards_pkey"
    PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX
"referral_rewards_inviteeId_key"
ON "referral_rewards"("inviteeId");

CREATE INDEX
"referral_rewards_referrerId_createdAt_idx"
ON "referral_rewards"("referrerId", "createdAt");

CREATE INDEX
"referral_rewards_inviteeSyncPending_idx"
ON "referral_rewards"("inviteeSyncPending");

CREATE INDEX
"referral_rewards_referrerSyncPending_idx"
ON "referral_rewards"("referrerSyncPending");

ALTER TABLE "referral_rewards"
ADD CONSTRAINT "referral_rewards_inviteeId_fkey"
FOREIGN KEY ("inviteeId")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "referral_rewards"
ADD CONSTRAINT "referral_rewards_referrerId_fkey"
FOREIGN KEY ("referrerId")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

/*
 * Все referrals, существовавшие ДО введения ledger,
 * считаем уже обработанными.
 *
 * Это критично: иначе следующий /start исторического
 * пользователя повторно начислит referral-награду.
 *
 * inviteeTrial/referrerBonus остаются NULL:
 * для legacy-записей мы не пытаемся ретроспективно
 * угадывать точную историю начисления.
 */
INSERT INTO "referral_rewards" (
    "id",
    "inviteeId",
    "referrerId",
    "inviteeTrial",
    "referrerBonus",
    "inviteeSyncPending",
    "referrerSyncPending",
    "appliedAt",
    "legacyBackfilled",
    "createdAt",
    "updatedAt"
)
SELECT
    'legacy-' || u."id",
    u."id",
    u."referredById",
    NULL,
    NULL,
    false,
    false,
    u."createdAt",
    true,
    u."createdAt",
    CURRENT_TIMESTAMP
FROM "users" u
WHERE u."referredById" IS NOT NULL
ON CONFLICT ("inviteeId") DO NOTHING;
