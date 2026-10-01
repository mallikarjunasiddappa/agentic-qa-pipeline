import { SprintInfo } from '../agileClient';
import { SprintStatusSprintSection } from './sprintStatus';

/**
 * Sprint plan (Phase C's other half, velocity only - "AI-Assisted Scrum and SDLC Console -
 * Development Plan," docs/planning/). Capacity/Tempo is explicitly OUT of scope here per the
 * repo owner's own instruction - this only answers "how many story points has this board actually
 * completed per sprint, recently," never "how many hours/points does the team have available."
 * A future PR can add capacity once Tempo-vs-manual-input is decided; nothing here blocks that.
 *
 * REUSES sprintStatus.ts'S OWN CATEGORIZATION, DOES NOT RE-DERIVE IT - same hard rule
 * burndownReport.ts's own header comment states and follows. buildBoardVelocityReport() below
 * takes an array of already-built SprintStatusSprintSection (one per CLOSED sprint this time,
 * instead of burndown's active-sprint sections - buildSprintStatusReport() itself does not care
 * whether the sprints it was handed are active or closed, it just categorizes whatever issues it's
 * given) and reads each section's own byStatusCategory.done.storyPoints/totalStoryPoints, rather
 * than re-summing raw issues a second time. The fetch loop (AgileClient.getClosedSprints() +
 * getSprintIssues() per closed sprint) lives in pipeline.ts's stageDraftSprintPlan(), same "each
 * stage function owns its own fetch calls" convention every other scrum stage in this file follows.
 */

export interface ClosedSprintVelocity {
  boardId: string;
  sprint: SprintInfo;
  completedStoryPoints: number;
  totalStoryPoints: number;
  unestimatedIssueCount: number;
}

export interface BoardVelocityReport {
  boardId: string;
  storyPointsField: string | null;
  // Most-recent-first, mirroring AgileClient.getClosedSprints()'s own ordering - not re-sorted here.
  closedSprints: ClosedSprintVelocity[];
  // Simple average of completedStoryPoints across closedSprints. null (not 0) when
  // storyPointsField is unconfigured (every completedStoryPoints would be a meaningless 0, same
  // "surface it, don't guess" reasoning as burndownReport.ts's percentComplete) or when there are
  // no closed sprints to average over (a brand-new board, or getClosedSprints's limit found none) -
  // either way, a caller must not silently treat null as "zero velocity."
  averageVelocity: number | null;
}

/**
 * Pure mapper: already-built SprintStatusSprintSection[] (one per closed sprint, from
 * buildSprintStatusReport() - see this file's header comment) -> this stage's own velocity shape.
 * Deliberately takes sections rather than raw AgileClient output, same boundary
 * buildBurndownSprintReport() already draws.
 */
export function buildBoardVelocityReport(
  boardId: string,
  closedSprintSections: SprintStatusSprintSection[],
  storyPointsField: string | null,
): BoardVelocityReport {
  const closedSprints: ClosedSprintVelocity[] = closedSprintSections.map((section) => ({
    boardId: section.boardId,
    sprint: section.sprint,
    completedStoryPoints: section.byStatusCategory.done.storyPoints,
    totalStoryPoints: section.totalStoryPoints,
    unestimatedIssueCount: section.unestimatedIssueCount,
  }));

  const averageVelocity =
    storyPointsField !== null && closedSprints.length > 0
      ? closedSprints.reduce((sum, s) => sum + s.completedStoryPoints, 0) / closedSprints.length
      : null;

  return { boardId, storyPointsField, closedSprints, averageVelocity };
}
