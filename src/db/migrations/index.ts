import type { Knex } from "knex";

import * as appSettings from "./20260713000001_app_settings";
import * as events from "./20260713000002_events";
import * as rules from "./20260713000003_rules";
import * as playbooks from "./20260713000004_playbooks";
import * as dispatches from "./20260713000005_dispatches";
import * as runsFindings from "./20260713000006_runs_findings";
import * as runCollected from "./20260713000007_run_collected";
import * as moduleConfig from "./20260713000008_module_config";
import * as seedResearcher from "./20260713000009_seed_researcher_playbook";
import * as playbookGrantedCapabilities from "./20260713000010_playbook_granted_capabilities";
import * as seedFxTeamLeadDigest from "./20260713000011_seed_fx_team_lead_digest";
import * as dropFxTeamLeadDigest from "./20260713000012_drop_fx_team_lead_digest";
import * as seedFxReactionPlaybooks from "./20260713000013_seed_fx_reaction_playbooks";
import * as seedPrBuildTest from "./20260713000014_seed_pr_build_test";
import * as adoWorkItemWebUrls from "./20260713000015_ado_workitem_web_urls";
import * as notifiers from "./20260713000016_notifiers";
import * as dropNotifierKind from "./20260713000017_drop_notifier_kind";
import * as playbookRunner from "./20260713000018_playbook_runner";
import * as snippets from "./20260713000019_snippets";
import * as playbookHost from "./20260713000020_playbook_host";
import * as playbookIsolation from "./20260713000021_playbook_isolation";

type Migration = {
  up: (knex: Knex) => Promise<void>;
  down: (knex: Knex) => Promise<void>;
};

/**
 * Migrations are registered explicitly here rather than discovered from the
 * filesystem. A custom migrationSource loads the same modules whether the code
 * is run as TypeScript (ts-jest) or from compiled `dist` JavaScript, so we
 * never have to reconcile `.ts`/`.js` extensions with knex's fs loader.
 *
 * Keys are the migration names; they run in ascending sort order, so keep the
 * timestamp prefix.
 */
const migrations: Record<string, Migration> = {
  "20260713000001_app_settings": appSettings,
  "20260713000002_events": events,
  "20260713000003_rules": rules,
  "20260713000004_playbooks": playbooks,
  "20260713000005_dispatches": dispatches,
  "20260713000006_runs_findings": runsFindings,
  "20260713000007_run_collected": runCollected,
  "20260713000008_module_config": moduleConfig,
  "20260713000009_seed_researcher_playbook": seedResearcher,
  "20260713000010_playbook_granted_capabilities": playbookGrantedCapabilities,
  "20260713000011_seed_fx_team_lead_digest": seedFxTeamLeadDigest,
  "20260713000012_drop_fx_team_lead_digest": dropFxTeamLeadDigest,
  "20260713000013_seed_fx_reaction_playbooks": seedFxReactionPlaybooks,
  "20260713000014_seed_pr_build_test": seedPrBuildTest,
  "20260713000015_ado_workitem_web_urls": adoWorkItemWebUrls,
  "20260713000016_notifiers": notifiers,
  "20260713000017_drop_notifier_kind": dropNotifierKind,
  "20260713000018_playbook_runner": playbookRunner,
  "20260713000019_snippets": snippets,
  "20260713000020_playbook_host": playbookHost,
  "20260713000021_playbook_isolation": playbookIsolation,
};

export const migrationSource: Knex.MigrationSource<string> = {
  async getMigrations() {
    return Object.keys(migrations).sort();
  },
  getMigrationName(name) {
    return name;
  },
  async getMigration(name) {
    return migrations[name];
  },
};
