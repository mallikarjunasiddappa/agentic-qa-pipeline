import fs from 'node:fs';
import path from 'node:path';
import { PersonasConfig, PersonasConfigSchema, Persona } from '../types/schemas';
import { getTenantId } from './tenantContext';

/**
 * Admin-provisioned per-tenant persona set for the Manual-Tester Agent's persona-exploration mode
 * (Mode A) - config/tenants/<tenantId>/personas.json. Same admin-config category as scrum.json and
 * capabilities.json (a human authors it; it is not pipeline-generated output), so it lives under
 * config/tenants/<tenantId>/ rather than data/<tenantId>/, and is kept as a function (not a
 * top-level const) so it never evaluates before setTenantId() has run.
 */
export function PERSONAS_CONFIG_PATH(): string {
  return path.join('config', 'tenants', getTenantId(), 'personas.json');
}

/**
 * Loads and validates config/tenants/<tenantId>/personas.json. Missing file -> an empty persona
 * list stamped with just the tenantId, not a thrown error - mirrors loadScrumConfig()/
 * loadCapabilities(): a tenant with no personas.json yet simply has no personas provisioned, which
 * --stage dogfood-run must treat as "nothing to explore" rather than a misconfiguration. Same
 * tenantId cross-check as those loaders: a file whose declared tenantId does not match the tenant
 * it was loaded for throws (almost always a copy-paste mistake when provisioning a new tenant).
 */
export function loadPersonasConfig(personasConfigPath: string = PERSONAS_CONFIG_PATH()): PersonasConfig {
  const tenantId = getTenantId();
  if (!fs.existsSync(personasConfigPath)) {
    return PersonasConfigSchema.parse({ tenantId });
  }
  const raw = JSON.parse(fs.readFileSync(personasConfigPath, 'utf-8'));
  const parsed = PersonasConfigSchema.parse(raw);
  if (parsed.tenantId !== tenantId) {
    throw new Error(
      `${personasConfigPath} declares tenantId "${parsed.tenantId}" but was loaded for tenant ` +
        `"${tenantId}" - this almost always means the file was copy-pasted from another tenant's ` +
        'config without updating its tenantId field. Fix the file (or its path) before continuing ' +
        "rather than risk applying the wrong tenant's personas.",
    );
  }
  return parsed;
}

/**
 * Resolves one persona by id (the --persona <id> flag on --stage dogfood-run). Throws an
 * actionable error listing the available ids rather than returning undefined, so a typo'd or
 * unprovisioned persona fails loudly at the CLI boundary instead of surfacing as a confusing
 * downstream "cannot read property of undefined".
 */
export function getPersona(config: PersonasConfig, id: string): Persona {
  const persona = config.personas.find((p) => p.id === id);
  if (!persona) {
    const available = config.personas.map((p) => p.id).join(', ') || '(none provisioned)';
    throw new Error(`No persona "${id}" in ${PERSONAS_CONFIG_PATH()}. Available: ${available}.`);
  }
  return persona;
}
