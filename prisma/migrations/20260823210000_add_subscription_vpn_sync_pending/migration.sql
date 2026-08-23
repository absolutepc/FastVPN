ALTER TABLE "subscriptions"
ADD COLUMN "vpnSyncPending" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "subscriptions_vpnSyncPending_idx"
ON "subscriptions"("vpnSyncPending");
