CREATE TABLE "Organization" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "name" TEXT NOT NULL,
  "legacyTenantId" TEXT UNIQUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE "Team" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id"),
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "name")
);

CREATE TABLE "Project" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id"),
  "teamId" TEXT REFERENCES "Team"("id"),
  "name" TEXT NOT NULL,
  "jiraProjectKey" TEXT,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "name")
);

CREATE TABLE "User" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id"),
  "email" TEXT NOT NULL,
  "displayName" TEXT,
  "ssoSubject" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "email")
);

CREATE TYPE "SyncState" AS ENUM ('IN_SYNC','CASE_DRIFTED','TEST_DRIFTED','BOTH_DRIFTED','ORPHANED_CASE','ORPHANED_TEST');
CREATE TYPE "HealingOutcome" AS ENUM ('healed','escalated','passed_no_heal_needed');
CREATE TYPE "FailureCategory" AS ENUM ('locator_drift','ui_restructure','copy_change','real_regression','environment_issue');
CREATE TYPE "FlakyAction" AS ENUM ('quarantined','cleared');

CREATE TABLE "WorkflowRecord" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
  "jiraKey" TEXT NOT NULL,
  "requirementGapsCheckedAt" TIMESTAMP,
  "requirementGaps" JSONB,
  "requirementsClearedAt" TIMESTAMP,
  "requirementsClearedByUserId" TEXT REFERENCES "User"("id"),
  "scenariosApprovedAt" TIMESTAMP,
  "scenariosApprovedByUserId" TEXT REFERENCES "User"("id"),
  "testCasesApprovedAt" TIMESTAMP,
  "testCasesApprovedByUserId" TEXT REFERENCES "User"("id"),
  UNIQUE ("projectId", "jiraKey")
);

CREATE TABLE "TraceabilityEntry" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
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
  "lastCheckedAt" TIMESTAMP NOT NULL,
  UNIQUE ("projectId", "jiraKey", "externalCaseId", "testFilePath", "testTitle")
);

CREATE TABLE "HealingEvent" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
  "timestamp" TIMESTAMP NOT NULL,
  "jiraKey" TEXT,
  "externalCaseId" TEXT,
  "testFilePath" TEXT NOT NULL,
  "testTitle" TEXT,
  "suite" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "outcome" "HealingOutcome" NOT NULL,
  "category" "FailureCategory",
  "durationMs" INTEGER
);
CREATE INDEX "HealingEvent_projectId_suite_timestamp_idx" ON "HealingEvent" ("projectId","suite","timestamp");

CREATE TABLE "FlakyEvent" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
  "timestamp" TIMESTAMP NOT NULL,
  "jiraKey" TEXT,
  "externalCaseId" TEXT,
  "testFilePath" TEXT NOT NULL,
  "testTitle" TEXT,
  "suite" TEXT NOT NULL,
  "evidence" JSONB NOT NULL,
  "action" "FlakyAction" NOT NULL
);
CREATE INDEX "FlakyEvent_projectId_testFilePath_timestamp_idx" ON "FlakyEvent" ("projectId","testFilePath","timestamp");

CREATE TABLE "QuarantineEntry" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
  "testFilePath" TEXT NOT NULL,
  "testTitle" TEXT,
  "jiraKey" TEXT,
  "externalCaseId" TEXT,
  "suite" TEXT NOT NULL,
  "quarantinedAt" TIMESTAMP NOT NULL,
  "evidence" JSONB NOT NULL,
  UNIQUE ("projectId", "testFilePath", "testTitle")
);

CREATE TABLE "CostEvent" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
  "timestamp" TIMESTAMP NOT NULL,
  "agent" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL,
  "outputTokens" INTEGER NOT NULL,
  "cacheReadTokens" INTEGER NOT NULL,
  "cacheCreationTokens" INTEGER NOT NULL,
  "costUsd" DECIMAL(12,6) NOT NULL,
  "wallClockMs" INTEGER NOT NULL,
  "jiraKey" TEXT
);
CREATE INDEX "CostEvent_projectId_agent_timestamp_idx" ON "CostEvent" ("projectId","agent","timestamp");

CREATE TABLE "AuditLogEntry" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "organizationId" TEXT NOT NULL REFERENCES "Organization"("id"),
  "userId" TEXT REFERENCES "User"("id"),
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "metadata" JSONB,
  "timestamp" TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX "AuditLogEntry_org_entity_ts_idx" ON "AuditLogEntry" ("organizationId","entityType","entityId","timestamp");

-- Phase A of "AI-Assisted Scrum and SDLC Console - Development Plan" (docs/planning/).
CREATE TYPE "QueueItemType" AS ENUM ('SUGGESTED','ESCALATED','NEEDS_SESSION');
CREATE TYPE "QueueItemState" AS ENUM ('PENDING','RESOLVED','DISMISSED');

CREATE TABLE "QueueItem" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id"),
  "type" "QueueItemType" NOT NULL,
  "sourceStage" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "state" "QueueItemState" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "resolvedAt" TIMESTAMP,
  "resolvedByUserId" TEXT REFERENCES "User"("id"),
  "actionTaken" TEXT
);
CREATE INDEX "QueueItem_projectId_state_type_idx" ON "QueueItem" ("projectId","state","type");
