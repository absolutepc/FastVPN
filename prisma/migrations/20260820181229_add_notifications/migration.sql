CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_isActive_createdAt_idx"
ON "notifications"("isActive", "createdAt");

CREATE INDEX "user_notifications_notificationId_idx"
ON "user_notifications"("notificationId");

CREATE UNIQUE INDEX "user_notifications_userId_notificationId_key"
ON "user_notifications"("userId", "notificationId");

ALTER TABLE "user_notifications"
ADD CONSTRAINT "user_notifications_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

ALTER TABLE "user_notifications"
ADD CONSTRAINT "user_notifications_notificationId_fkey"
FOREIGN KEY ("notificationId")
REFERENCES "notifications"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
