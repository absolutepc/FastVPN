-- Preserve each subscription's current UUID/token as device slot 1, then
-- allow a separate slot 2 with its own credentials.
ALTER TABLE "devices"
ADD COLUMN "subToken" TEXT,
ADD COLUMN "slot" INTEGER,
ADD COLUMN "vpnSyncPending" BOOLEAN NOT NULL DEFAULT false;

UPDATE "devices" AS d
SET
  "userId" = s."userId",
  "uuid" = s."uuid",
  "subToken" = s."subToken",
  "slot" = 1,
  "isActive" = true,
  "vpnSyncPending" = false
FROM "subscriptions" AS s
WHERE s."id" = d."subscriptionId";

INSERT INTO "devices" (
  "id", "userId", "subscriptionId", "uuid", "subToken", "slot",
  "name", "platform", "isActive", "vpnSyncPending", "lastSeenAt",
  "createdAt", "updatedAt"
)
SELECT
  'legacy_' || md5(s."id"),
  s."userId",
  s."id",
  s."uuid",
  s."subToken",
  1,
  'Основное устройство',
  NULL,
  true,
  false,
  NULL,
  s."createdAt",
  NOW()
FROM "subscriptions" AS s
WHERE NOT EXISTS (
  SELECT 1 FROM "devices" AS d
  WHERE d."subscriptionId" = s."id"
);

ALTER TABLE "devices"
ALTER COLUMN "subToken" SET NOT NULL,
ALTER COLUMN "slot" SET NOT NULL;

DROP INDEX "devices_subscriptionId_key";

CREATE UNIQUE INDEX "devices_subToken_key" ON "devices"("subToken");
CREATE UNIQUE INDEX "devices_subscriptionId_slot_key"
ON "devices"("subscriptionId", "slot");
CREATE INDEX "devices_vpnSyncPending_idx"
ON "devices"("vpnSyncPending");

ALTER TABLE "devices"
ADD CONSTRAINT "devices_slot_check" CHECK ("slot" BETWEEN 1 AND 2);

-- Existing H1Cloud rows are the primary device's remote clients.
ALTER TABLE "h1cloud_clients" ADD COLUMN "deviceId" TEXT;

UPDATE "h1cloud_clients" AS h
SET "deviceId" = d."id"
FROM "devices" AS d
WHERE d."subscriptionId" = h."subscriptionId"
  AND d."slot" = 1;

ALTER TABLE "h1cloud_clients" ALTER COLUMN "deviceId" SET NOT NULL;

DROP INDEX "h1cloud_clients_subscriptionId_nodeKey_key";

CREATE UNIQUE INDEX "h1cloud_clients_deviceId_nodeKey_key"
ON "h1cloud_clients"("deviceId", "nodeKey");
CREATE INDEX "h1cloud_clients_deviceId_idx"
ON "h1cloud_clients"("deviceId");

ALTER TABLE "h1cloud_clients"
ADD CONSTRAINT "h1cloud_clients_deviceId_fkey"
FOREIGN KEY ("deviceId") REFERENCES "devices"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
