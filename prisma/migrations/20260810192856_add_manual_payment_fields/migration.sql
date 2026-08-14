-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "bank" TEXT,
ADD COLUMN     "paymentMethod" TEXT,
ADD COLUMN     "proofFileId" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedBy" TEXT;
