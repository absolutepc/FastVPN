CREATE TYPE "SupportTicketStatus" AS ENUM (
  'NEW',
  'IN_PROGRESS',
  'RESOLVED'
);

CREATE TABLE "support_tickets" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "attachmentUrl" TEXT,
  "status" "SupportTicketStatus" NOT NULL DEFAULT 'NEW',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "support_tickets_pkey"
    PRIMARY KEY ("id")
);

CREATE INDEX
  "support_tickets_userId_createdAt_idx"
ON
  "support_tickets"("userId", "createdAt");

CREATE INDEX
  "support_tickets_status_createdAt_idx"
ON
  "support_tickets"("status", "createdAt");

ALTER TABLE "support_tickets"
ADD CONSTRAINT
  "support_tickets_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
