-- AlterTable
ALTER TABLE "Incident" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "PaymaxisBackfill" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Shift" ADD COLUMN     "endedBy" TEXT,
ADD COLUMN     "handoverTo" TEXT,
ADD COLUMN     "kyc" JSONB,
ADD COLUMN     "name" TEXT NOT NULL DEFAULT 'Ad Hoc',
ADD COLUMN     "opsDay" TEXT,
ADD COLUMN     "slot" INTEGER,
ADD COLUMN     "startBalances" JSONB,
ADD COLUMN     "startNotes" TEXT,
ADD COLUMN     "takenOverFrom" TEXT,
ADD COLUMN     "tickets" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "ShiftParticipant" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "ShiftParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskTemplate" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "howTo" TEXT,
    "category" TEXT NOT NULL DEFAULT 'Operations',
    "appliesTo" TEXT NOT NULL DEFAULT 'All Shifts',
    "priority" TEXT NOT NULL DEFAULT 'Medium',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShiftTask" (
    "id" TEXT NOT NULL,
    "shiftId" TEXT,
    "templateId" TEXT,
    "title" TEXT NOT NULL,
    "howTo" TEXT,
    "category" TEXT NOT NULL DEFAULT 'Operations',
    "priority" TEXT NOT NULL DEFAULT 'Medium',
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "notes" TEXT,
    "assigneeId" TEXT,
    "completedBy" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShiftTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShiftParticipant_userId_idx" ON "ShiftParticipant"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ShiftParticipant_shiftId_userId_key" ON "ShiftParticipant"("shiftId", "userId");

-- CreateIndex
CREATE INDEX "TaskTemplate_active_idx" ON "TaskTemplate"("active");

-- CreateIndex
CREATE INDEX "ShiftTask_shiftId_status_idx" ON "ShiftTask"("shiftId", "status");

-- CreateIndex
CREATE INDEX "ShiftTask_assigneeId_idx" ON "ShiftTask"("assigneeId");

-- CreateIndex
CREATE INDEX "Shift_status_idx" ON "Shift"("status");

-- CreateIndex
CREATE INDEX "Shift_opsDay_idx" ON "Shift"("opsDay");

-- CreateIndex
CREATE INDEX "Shift_startedAt_idx" ON "Shift"("startedAt");

-- AddForeignKey
ALTER TABLE "ShiftParticipant" ADD CONSTRAINT "ShiftParticipant_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftParticipant" ADD CONSTRAINT "ShiftParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftTask" ADD CONSTRAINT "ShiftTask_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftTask" ADD CONSTRAINT "ShiftTask_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "TaskTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShiftTask" ADD CONSTRAINT "ShiftTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
