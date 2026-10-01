import fs from 'node:fs';
import path from 'node:path';
import { ScrumConfig, ScrumConfigSchema } from '../types/schemas';
import { getTenantId } from './tenantContext';

/**
 * Admin-provisioned per-tenant Scrum Master Automation config - scrum/config.json (docs/planning's
 * Option 1 Technical Document, Section 4.4; ScrumConfigSchema's own doc comment in schemas.ts has
 * the full field-by-field rationale). Same category as capabilities.json and policy.json - not
 * pipeline-generated output, so it lives outside data/<tenantId>/ same as CAPABILITIES_PATH()
 * below. Kept as a function (not a top-level const) for the same reason every tenant-scoped path
 * in this pipeline is - it must not evaluate before setTenantId() has run.
 *
 * Nested under config/tenants/<tenantId>/ alongside capabilities.json - the file-path decision
 * already recorded in ScrumConfigSchema's doc comment (nested, not a flat
 * config/tenants/<tenantId>-scrum.json sibling). This module and CAPABILITIES_PATH()'s matching
 * migration (capabilityStore.ts) land together in this same PR - the "one migration, not two"
 * that comment called for.
 */
export function SCRUM_CONFIG_PATH(): string {
  return path.join('config', 'tenants', getTenantId(), 'scrum.json');
}

/**
 * Loads and validates config/tenants/<tenantId>/scrum.json. Missing file -> schema defaults
 * stamped with just the tenantId, not a thrown error - mirrors loadCapabilities()'s opt-out
 * reasoning (contrast policyStore.ts's loadPolicy(), which fails loud on a missing policy.json): a
 * tenant with no scrum.json yet simply has no scrum config provisioned, which the stages that
 * read this (sprint-status onward, Phase 1) must treat as "nothing to report" rather than a
 * misconfiguration. No deterministic scrum stage reads this yet - this loader is being built now,
 * ahead of the first stage that needs it, so Phase 1's stage PRs land against an already-reviewed
 * loader instead of each inventing their own.
 *
 * Same tenantId cross-check as loadCapabilities(): a file's declared tenantId not matching the
 * tenant it was loaded for throws, rather than silently applying the wrong tenant's scrum config -
 * almost always a copy-paste mistake when provisioning a new tenant from an existing one's file.
 */
export function loadScrumConfig(scrumConfigPath: string = SCRUM_CONFIG_PATH()): ScrumConfig {
  const tenantId = getTenantId();
  if (!fs.existsSync(scrumConfigPath)) {
    return ScrumConfigSchema.parse({ tenantId });
  }
  const raw = JSON.parse(fs.readFileSync(scrumConfigPath, 'utf-8'));
  const parsed = ScrumConfigSchema.parse(raw);
  if (parsed.tenantId !== tenantId) {
    throw new Error(
      `${scrumConfigPath} declares tenantId "${parsed.tenantId}" but was loaded for tenant ` +
        `"${tenantId}" - this almost always means the file was copy-pasted from another tenant's ` +
        'config without updating its tenantId field. Fix the file (or its path) before continuing ' +
        "rather than risk applying the wrong tenant's scrum config.",
    );
  }
  return parsed;
}

/**
 * Writes an already-validated ScrumConfig back to config/tenants/<tenantId>/scrum.json. Takes a
 * ScrumConfig, not a raw object, so the type system itself enforces "only ever write something
 * that has already passed ScrumConfigSchema.parse()" - there is deliberately no path from an
 * unvalidated value to disk. Pretty-printed with a trailing newline, matching every other
 * hand-authored/generated JSON file in this repo (config/tenants/*.json, data/<tenantId>/**\/*.json
 * via scrumDashboard.ts and friends).
 */
export function saveScrumConfig(config: ScrumConfig, scrumConfigPath: string = SCRUM_CONFIG_PATH()): void {
  fs.mkdirSync(path.dirname(scrumConfigPath), { recursive: true });
  fs.writeFileSync(scrumConfigPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

/**
 * Dashboard v1, PR 2 (Settings panel): the small, explicit allow-list of scrum.json fields an
 * admin may edit via the workflow_dispatch Settings panel (.github/workflows/settings-update.yml)
 * plus the pure update-and-validate logic --stage settings-update (pipeline.ts) calls. Starts with
 * exactly the two fields the Technical Document already names as concrete examples -
 * blockerEscalation.idleDaysThreshold and storyPointsField - per PR 2's own kickoff spec.
 * Deliberately NOT a generic "set any JSON path" tool: adding a third editable field later is a
 * one-line addition to SCRUM_SETTING_REGISTRY below (plus a matching option in the workflow's
 * `setting` choice dropdown), not a schema or validation-logic change.
 */
export const SCRUM_SETTING_KEYS = ['storyPointsField', 'blockerEscalation.idleDaysThreshold'] as const;
export type ScrumSettingKey = (typeof SCRUM_SETTING_KEYS)[number];

interface ScrumSettingDefinition {
  // Parses the raw workflow_dispatch string input into the real typed value this field expects,
  // throwing a specific, field-aware error when it doesn't parse. Every workflow_dispatch input
  // arrives as a string regardless of the field's real type (GitHub Actions has no numeric input
  // type) - this coercion has to happen before the value can ever satisfy ScrumConfigSchema, which
  // does not itself coerce strings to numbers.
  parse: (rawValue: string) => unknown;
  // Applies the already-parsed value onto a *new* config object - never mutates the one it's
  // given, same immutability posture as every buildXReport() pure builder elsewhere in this
  // pipeline.
  apply: (config: ScrumConfig, value: unknown) => ScrumConfig;
}

const SCRUM_SETTING_REGISTRY: Record<ScrumSettingKey, ScrumSettingDefinition> = {
  storyPointsField: {
    parse: (rawValue) => {
      const trimmed = rawValue.trim();
      if (trimmed === '') {
        throw new Error(
          'storyPointsField cannot be set to an empty value - pass the real Jira custom field id ' +
            '(e.g. "customfield_10016").',
        );
      }
      return trimmed;
    },
    apply: (config, value) => ({ ...config, storyPointsField: value as string }),
  },
  'blockerEscalation.idleDaysThreshold': {
    parse: (rawValue) => {
      const n = Number(rawValue);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`blockerEscalation.idleDaysThreshold must be a whole number >= 1, got "${rawValue}".`);
      }
      return n;
    },
    apply: (config, value) => ({
      ...config,
      blockerEscalation: { ...config.blockerEscalation, idleDaysThreshold: value as number },
    }),
  },
};

/**
 * Applies one Settings-panel edit to an already-loaded ScrumConfig and re-validates the WHOLE
 * result against ScrumConfigSchema - the exact same schema loadScrumConfig() above (and therefore
 * every pipeline stage that reads scrum.json) already trusts - before returning. Throws loudly,
 * never returns a partially-applied or unvalidated config, on: an unknown setting key not in
 * SCRUM_SETTING_KEYS, a raw value that fails that field's own type/range check, or - belt and
 * braces, in case a future registry entry's apply() could somehow still produce something invalid
 * - a final result that fails ScrumConfigSchema.parse(). The caller (stageSettingsUpdate,
 * pipeline.ts) only calls saveScrumConfig() after this function returns successfully, so an
 * invalid update never reaches disk, not even partially.
 */
export function applyScrumSettingUpdate(config: ScrumConfig, setting: string, rawValue: string): ScrumConfig {
  const definition = SCRUM_SETTING_REGISTRY[setting as ScrumSettingKey];
  if (!definition) {
    throw new Error(`Unknown setting "${setting}" - the Settings panel only supports: ${SCRUM_SETTING_KEYS.join(', ')}.`);
  }
  const value = definition.parse(rawValue);
  const updated = definition.apply(config, value);
  return ScrumConfigSchema.parse(updated);
}
