CREATE UNIQUE INDEX "subscriptions_one_active_per_user"
ON "subscriptions" ("userId")
WHERE "status" IN ('ACTIVE', 'TRIAL');
