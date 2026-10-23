CREATE TABLE "CronExportLock" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronExportLock_pkey" PRIMARY KEY ("id")
);