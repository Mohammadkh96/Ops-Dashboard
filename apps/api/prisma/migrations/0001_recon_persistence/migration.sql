
-- CreateTable
CREATE TABLE "ReconPspConfig" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconPspConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconRun" (
    "id" TEXT NOT NULL,
    "ranAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ranBy" TEXT,
    "layer1Matched" INTEGER NOT NULL DEFAULT 0,
    "layer1Total" INTEGER NOT NULL DEFAULT 0,
    "layer2Matched" INTEGER NOT NULL DEFAULT 0,
    "layer2Total" INTEGER NOT NULL DEFAULT 0,
    "exceptionCount" INTEGER NOT NULL DEFAULT 0,
    "exposure" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL,

    CONSTRAINT "ReconRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconCase" (
    "caseKey" TEXT NOT NULL,
    "resolution" TEXT NOT NULL DEFAULT 'Open',
    "owner" TEXT,
    "notes" TEXT,
    "priority" TEXT,
    "status" TEXT,
    "entity" TEXT,
    "brand" TEXT,
    "psp" TEXT,
    "reference" TEXT,
    "exposure" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReconCase_pkey" PRIMARY KEY ("caseKey")
);

-- CreateIndex
CREATE INDEX "ReconRun_ranAt_idx" ON "ReconRun"("ranAt");

-- CreateIndex
CREATE INDEX "ReconCase_resolution_idx" ON "ReconCase"("resolution");

-- CreateIndex
CREATE INDEX "ReconCase_priority_idx" ON "ReconCase"("priority");

