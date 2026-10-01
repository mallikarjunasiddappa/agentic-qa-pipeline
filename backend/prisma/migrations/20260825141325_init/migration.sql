-- CreateEnum
CREATE TYPE "SyncState" AS ENUM ('IN_SYNC', 'CASE_DRIFTED', 'TEST_DRIFTED', 'BOTH_DRIFTED', 'ORPHANED_CASE', 'ORPHANED_TEST');

-- CreateEnum
CREATE TYPE "HealingOutcome" AS ENUM ('healed', 'escalated', 'passed_no_heal_needed');

-- CreateEnum
CREATE TYPE "FailureCategory" AS ENUM ('locator_drift', 'ui_restructure', 'copy_change', 'real_regression', 'environment_issue');

-- CreateEnum
CREATE TYPE "FlakyAction" AS ENUM ('quarantined', 'cleared');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legacyTenantId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "teamId" TEXT,
    "name" TEXT NOT NULL,
    "jiraProjectKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "ssoSubject" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRecord" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "jiraKey" TEXT NOT NULL,
    "requirementGapsCheckedAt" TIMESTAMP(3),
    "requirementGaps" JSONB,
    "requirementsClearedAt" TIMESTAMP(3),
    "requirementsClearedByUserId" TEXT,
    "scenariosApprovedAt" TIMESTAMP(3),
    "scenariosApprovedByUserId" TEXT,
    "testCasesApprovedAt" TIMESTAMP(3),
    "testCasesApprovedByUserId" TEXT,

    CONSTRAINT "WorkflowRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TraceabilityEntry" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "jiraKey" TEXT NOT NULL,
    "externalCaseId" TEXT NOT NULL,
    "externalCaseHash" TEXT NOT NULL,
    "externalCaseUpdatedAt" TEXT NOT NULL,
    "tmsProvider" TEXT NOT NULL,
    "testFilePath" TEXT NOT NULL,
    "testTitle" TEXT,
    "testContentHash" TEXT NOT NULL,
    "testLastModified" TEXT NOT NULL,
    "syncState" "SyncState" NOT NULL,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TraceabilityEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HealingEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "jiraKey" TEXT,
    "externalCaseId" TEXT,
    "testFilePath" TEXT NOT NULL,
    "testTitle" TEXT,
    "suite" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "outcome" "HealingOutcome" NOT NULL,
    "category" "FailureCategory",
    "durationMs" INTEGER,

    CONSTRAINT "HealingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlakyEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "jiraKey" TEXT,
    "externalCaseId" TEXT,
    "testFilePath" TEXT NOT NULL,
    "testTitle" TEXT,
    "suite" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "action" "FlakyAction" NOT NULL,

    CONSTRAINT "FlakyEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuarantineEntry" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "testFilePath" TEXT NOT NULL,
    "testTitle" TEXT,
    "jiraKey" TEXT,
    "externalCaseId" TEXT,
    "suite" TEXT NOT NULL,
    "quarantinedAt" TIMESTAMP(3) NOT NULL,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "QuarantineEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "agent" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "cacheCreationTokens" INTEGER NOT NULL,
    "costUsd" DECIMAL(12,6) NOT NULL,
    "wallClockMs" INTEGER NOT NULL,
    "jiraKey" TEXT,

    CONSTRAINT "CostEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLogEntry" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "metadata" JSONB,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_legacyTenantId_key" ON "Organization"("legacyTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Team_organizationId_name_key" ON "Team"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Project_organizationId_name_key" ON "Project"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "User_ssoSubject_key" ON "User"("ssoSubject");

-- CreateIndex
CREATE UNIQUE INDEX "User_organizationId_email_key" ON "User"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRecord_projectId_jiraKey_key" ON "WorkflowRecord"("projectId", "jiraKey");

-- CreateIndex
CREATE UNIQUE INDEX "TraceabilityEntry_projectId_jiraKey_externalCaseId_testFile_key" ON "TraceabilityEntry"("projectId", "jiraKey", "externalCaseId", "testFilePath", "testTitle");

-- CreateIndex
CREATE INDEX "HealingEvent_projectId_suite_timestamp_idx" ON "HealingEvent"("projectId", "suite", "timestamp");

-- CreateIndex
CREATE INDEX "FlakyEvent_projectId_testFilePath_timestamp_idx" ON "FlakyEvent"("projectId", "testFilePath", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "QuarantineEntry_projectId_testFilePath_testTitle_key" ON "QuarantineEntry"("projectId", "testFilePath", "testTitle");

-- CreateIndex
CREATE INDEX "CostEvent_projectId_agent_timestamp_idx" ON "CostEvent"("projectId", "agent", "timestamp");

-- CreateIndex
CREATE INDEX "AuditLogEntry_organizationId_entityType_entityId_timestamp_idx" ON "AuditLogEntry"("organizationId", "entityType", "entityId", "timestamp");

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRecord" ADD CONSTRAINT "WorkflowRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRecord" ADD CONSTRAINT "WorkflowRecord_requirementsClearedByUserId_fkey" FOREIGN KEY ("requirementsClearedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRecord" ADD CONSTRAINT "WorkflowRecord_scenariosApprovedByUserId_fkey" FOREIGN KEY ("scenariosApprovedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRecord" ADD CONSTRAINT "WorkflowRecord_testCasesApprovedByUserId_fkey" FOREIGN KEY ("testCasesApprovedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TraceabilityEntry" ADD CONSTRAINT "TraceabilityEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HealingEvent" ADD CONSTRAINT "HealingEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlakyEvent" ADD CONSTRAINT "FlakyEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuarantineEntry" ADD CONSTRAINT "QuarantineEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostEvent" ADD CONSTRAINT "CostEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLogEntry" ADD CONSTRAINT "AuditLogEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
