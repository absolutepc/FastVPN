-- CreateTable
CREATE TABLE "h1cloud_clients" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "nodeKey" TEXT NOT NULL,
    "remoteName" TEXT NOT NULL,
    "remoteUuid" TEXT NOT NULL,
    "remoteLink" TEXT NOT NULL,
    "remoteSubUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "h1cloud_clients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "h1cloud_clients_subscriptionId_idx" ON "h1cloud_clients"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "h1cloud_clients_subscriptionId_nodeKey_key" ON "h1cloud_clients"("subscriptionId", "nodeKey");

-- CreateIndex
CREATE UNIQUE INDEX "h1cloud_clients_nodeKey_remoteName_key" ON "h1cloud_clients"("nodeKey", "remoteName");

-- CreateIndex
CREATE UNIQUE INDEX "h1cloud_clients_nodeKey_remoteUuid_key" ON "h1cloud_clients"("nodeKey", "remoteUuid");

-- AddForeignKey
ALTER TABLE "h1cloud_clients" ADD CONSTRAINT "h1cloud_clients_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
