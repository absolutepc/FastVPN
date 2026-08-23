
ALTER TABLE "notifications"
ADD COLUMN "recipientUserId" TEXT;

CREATE INDEX
"notifications_recipientUserId_isActive_createdAt_idx"
ON "notifications"(
  "recipientUserId",
  "isActive",
  "createdAt"
);

ALTER TABLE "notifications"
ADD CONSTRAINT "notifications_recipientUserId_fkey"
FOREIGN KEY ("recipientUserId")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;

