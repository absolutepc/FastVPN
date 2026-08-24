CREATE TABLE "owner_invites" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "owner_invites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "owner_invite_redemptions" (
    "id" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "daysGranted" INTEGER NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "owner_invite_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "owner_invites_token_key"
ON "owner_invites"("token");

CREATE INDEX "owner_invites_createdById_createdAt_idx"
ON "owner_invites"("createdById", "createdAt");

CREATE INDEX "owner_invites_isActive_idx"
ON "owner_invites"("isActive");

CREATE UNIQUE INDEX "owner_invite_redemptions_userId_key"
ON "owner_invite_redemptions"("userId");

CREATE INDEX "owner_invite_redemptions_inviteId_idx"
ON "owner_invite_redemptions"("inviteId");

ALTER TABLE "owner_invites"
ADD CONSTRAINT "owner_invites_createdById_fkey"
FOREIGN KEY ("createdById")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "owner_invite_redemptions"
ADD CONSTRAINT "owner_invite_redemptions_inviteId_fkey"
FOREIGN KEY ("inviteId")
REFERENCES "owner_invites"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "owner_invite_redemptions"
ADD CONSTRAINT "owner_invite_redemptions_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
