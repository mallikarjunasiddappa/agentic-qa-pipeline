/**
 * Scrum Master Agent module tree - client-plus-three-real-stages (Phase 1, PR 7 of several; see
 * .claude/agents/scrum-master-agent.md for this agent's full charter and current-state note).
 *
 * `vcsClient/` (provider-agnostic VcsClient interface + GitHub adapter, mirroring testmgmt/'s own
 * types.ts/client.ts/adapter.ts/index.ts split) is real - not a single flat vcsClient.ts as
 * originally sketched here, since the interface/adapter split needed its own directory the same
 * way testmgmt/ did.
 *
 * `agileClient.ts` is real too - a single flat file rather than a directory, since (unlike
 * vcsClient/) there's no multi-provider need here: it's always the same Jira Cloud instance as
 * jiraClient.ts, just the /rest/agile/1.0 surface instead of /rest/api/3. Scoped to a
 * current-sprint snapshot only - the committed/completed/carried-over burndown deltas Jira's own
 * UI shows live behind an undocumented/deprecated Greenhopper endpoint this project does not
 * depend on; that's Phase 3's burndown-report instead.
 *
 * Eight stages are wired into pipeline.ts's --stage switch: `stages/devStatus.ts`
 * (`--stage dev-status` - open-PR/branch activity via vcsClient/, matched to Jira ticket keys via
 * its own matchBranchToTicket()), `stages/sprintStatus.ts` (`--stage sprint-status` -
 * current-sprint snapshot via agileClient.ts, one report section per (board, active sprint) pair
 * across scrum.json's configured boardIds), `stages/standupDigest.ts` (`--stage
 * standup-digest` - the same active-sprint issue data as sprint-status, regrouped by assignee into
 * a per-person activity digest), `stages/blockerScan.ts` (`--stage blocker-scan` - Phase 2's first
 * duty, and the first stage in this whole module that writes anything - see below), and
 * `stages/groomCheck.ts` (`--stage groom-check-fetch` + `--stage groom-check-flag` - Phase 2's
 * second and final duty - see further below; a genuinely different shape from every stage before
 * it), `stages/burndownReport.ts` (`--stage burndown-report` - Phase 3's first duty, fully
 * deterministic, see further below), and `stages/retroNotes.ts` (`--stage retro-notes-fetch` +
 * `--stage retro-notes-post` - Phase 3's second and final duty, see further below; same
 * two-deterministic-bookends-plus-live-judgment shape as groomCheck.ts). standup-digest delivers
 * DM ONLY - a per-assignee Slack DM via sendTicketSummaryDm(), now that the Jira account
 * migration (personal -> company account) is confirmed live
 * and assigneeEmail can be trusted; channel-mode delivery remains a deliberately separate future
 * PR. See that file's own header comment for the full delivery reasoning. See README.md's "Scrum
 * Master Automation Program" section for the full behavior of each stage (including devStatus's
 * unlinked-activity/trunk-exclusion decisions, sprintStatus's every-active-sprint/unconfigured-
 * storyPointsField decisions, standup-digest's no-blocked-bucket and DM-only-delivery decisions,
 * blocker-scan's idle-days/blocked-definition/channel-routing/no-dedup-yet decisions, and
 * groom-check-fetch's real-data-checked QA-vs-dev reasoning).
 *
 * blockerScan.ts is a real trust-boundary step up from the three stages before it: it's the first
 * thing this module writes anywhere (a Jira comment on the assignee's ticket, and/or a Slack
 * message to configured relatedRecipients) rather than only reporting or DM-ing a digest. It is
 * gated by its own `scrumBlockerScan` capability flag (independent of scrumCeremony/
 * scrumDevStatus - see capabilityStore.ts) and is deliberately manual-CLI-only for now - not wired
 * into scrum-ceremony-report.yml's cron - since it has no cross-run escalation dedup yet (every
 * run re-flags and re-escalates every still-idle ticket from scratch); that gap must close before
 * this stage is trusted to run unattended on a schedule.
 *
 * groomCheck.ts is a different kind of step up again - not just a new write action, but the first
 * duty in this module with NO deterministic judgment function at all. DECIDED (Continuity Log,
 * Aug 22 "backlog-groom-check build approach"): the actual "is this ticket clear enough" call -
 * reframed per ticket type, "can scenarios be generated from this" for QA tickets / "can a
 * developer start building from this" for dev tickets - is made live, by a human or Cowork running
 * scrum-master-agent.md's own instructions, mirroring planning-agent.md's Gate 0 exactly, since
 * this codebase has zero direct-Anthropic-API-call infrastructure to automate that judgment with.
 * groomCheck.ts itself only provides the two deterministic bookends: buildGroomCheckFetchReport()
 * (a pure mapper - fetched tickets in, a report out, no judgment) and buildGroomCheckComment() (a
 * pure formatter for whatever gaps the live judgment step already decided on) - see that file's
 * own header comment for why a QA-vs-dev Jira-metadata detection rule was deliberately NOT built:
 * the real SCRUM project's issue-type/label/component data was checked first, and carries no such
 * signal today (every real ticket is issue type "Task", no labels, no components configured).
 * Gated by its own `scrumGroomCheck` capability flag, and - like blocker-scan - never cron-wired;
 * unlike blocker-scan, there is no automated version of this duty to eventually schedule at all.
 *
 * burndownReport.ts is Phase 3's first duty, and a return to a fully deterministic shape after
 * groomCheck.ts's live-judgment step - no write/escalation side effect like blockerScan.ts, no
 * live judgment like groomCheck.ts. It reuses agileClient.ts completely unchanged (no new client
 * method) and sprintStatus.ts's own buildSprintStatusReport()/SprintStatusSprintSection - the
 * per-sprint byStatusCategory/totalStoryPoints/unestimatedIssueCount math stays exactly one
 * implementation, not two, now that a second stage needs it - reshaping each section into a
 * completed-vs-remaining view rather than a historical trend line (see that file's own header
 * comment for why a real burndown chart or committed-vs-actual delta is explicitly out of scope:
 * Jira's own UI gets those from an undocumented/deprecated endpoint this project does not depend
 * on, and this stage does not persist day-over-day snapshots to approximate one either). Writes
 * one JSON+Markdown pair PER (board, active sprint) pair - data/<tenantId>/scrum/
 * burndown-<sprintId>.json/.md, keyed by the sprint's numeric id - not the single combined
 * report.json every earlier stage's static REPORT_JSON_PATH()/REPORT_MD_PATH() helper writes,
 * since a burndown is inherently a per-sprint artifact. Gated by its own scrumBurndown capability
 * flag, same per-duty-gets-its-own-gate precedent as scrumBlockerScan/scrumGroomCheck.
 *
 * retroNotes.ts is Phase 3's second and final duty, and the same genuinely-different-shape-with-
 * no-deterministic-judgment-function pattern groomCheck.ts already established - DECIDED (Option
 * B, same as groomCheck.ts): the actual retrospective synthesis (what went well, what didn't,
 * action items) is made live, by a human or Cowork running scrum-master-agent.md's own
 * instructions, never a deterministic function, for the identical "zero direct-Anthropic-API-call
 * infrastructure" reason groomCheck.ts's own header comment already documents. retroNotes.ts
 * itself only provides the two deterministic bookends: buildRetroNotesFetchReport() (a pure
 * mapper - sprint tickets plus their correlated VCS activity in, a report out, no synthesis) and
 * buildRetroNotesFile() (a pure formatter wrapping whatever notes text the live synthesis step
 * already produced). The VCS half reuses devStatus.ts's exported buildDevStatusReport() unchanged
 * via a new pure correlation function, findVcsActivityForTicket() - no new client method, no
 * re-derived branch-to-ticket matching. QA telemetry (healing/flaky/traceability data) is
 * deliberately NOT wired into the fetch report - confirmed with the user rather than guessed,
 * since none of it is sprint-scoped today (see retroNotes.ts's own header comment for the
 * real-data check behind that decision) - a known, flagged gap, not a silent omission. Writes its
 * own working data to data/<tenantId>/retroNotes/report.json/.md (dedicated directory, mirroring
 * groomCheck.ts's REPORT_JSON_PATH()/REPORT_MD_PATH() convention), but the final retro itself goes
 * to data/<tenantId>/scrum/retro-<sprintId>.md - file only, confirmed with the user (no Jira
 * comment, no Slack post, unlike backlog-groom-check), keyed by sprint id the same way
 * burndownReport.ts keys its own per-sprint files. Gated by its own scrumRetro capability flag,
 * same per-duty-gets-its-own-gate precedent as scrumBlockerScan/scrumGroomCheck/scrumBurndown, and
 * - like groomCheck.ts - never cron-wired; there is no automated version of this duty to schedule.
 *
 * Phase 3 is now complete (burndownReport.ts plus retroNotes.ts). No further phase is currently
 * tracked in the Technical Document's phase table for this module.
 *
 * No cross-agent imports: this module (including vcsClient/, agileClient.ts, and stages/) may read
 * `../config/scrumConfigStore.ts` and `../config/capabilityStore.ts` (shared infra every agent
 * uses), but must never import another agent's owned client (`../jira/jiraClient.ts`,
 * `../testmgmt/qaseClient.ts`, etc.) directly - the same rule every existing agent already
 * follows.
 */
export {};
