CREATE TYPE "UserRole" AS ENUM (
  'USER',
  'ADMIN',
  'OWNER'
);

ALTER TABLE "users"
ADD COLUMN "role" "UserRole" NOT NULL DEFAULT 'USER';

UPDATE "users"
SET "role" = 'OWNER'
WHERE "telegramId" = 5043563352;
