CREATE TYPE "SupportMessageAuthor" AS ENUM (
  'USER',
  'ADMIN'
);

CREATE TABLE "support_ticket_messages" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "author" "SupportMessageAuthor" NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "support_ticket_messages_pkey"
    PRIMARY KEY ("id")
);

CREATE INDEX
  "support_ticket_messages_ticketId_createdAt_idx"
ON
  "support_ticket_messages"("ticketId", "createdAt");

ALTER TABLE "support_ticket_messages"
ADD CONSTRAINT
  "support_ticket_messages_ticketId_fkey"
FOREIGN KEY ("ticketId")
REFERENCES "support_tickets"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
