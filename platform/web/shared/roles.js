// The permission map in the browser. Fetched once from /auth/roles and read
// by every page; no page hard-codes a role name. Roles are workflow labels,
// not security: the server applies the same map to writes.
import { identity } from './fhir.js';

let data = null;
let loading = null;

/** Loads the map once per page. Later calls return the cached copy. */
export async function loadRoles() {
  if (data) return data;
  if (!loading) {
    loading = fetch('/auth/roles').then((r) => r.json()).then((d) => {
      data = d;
      // A role this server does not know (for example one left in the browser from an older build) falls back to the first role.
      if (!d.roles.some((r) => r.id === identity.role)) identity.role = d.roles[0].id;
      return d;
    });
  }
  return loading;
}

/** The current role's permission (apps, landing, nav, chartTabs, readOnlyTabs, writes). Null before the map is loaded or for an unknown role. */
export function currentPermission() {
  return data?.roles.find((r) => r.id === identity.role) || null;
}
export const roleList = () => data?.roles || [];
export const isBuilt = (app) => Boolean(data?.built[app]);
export const currentApp = () => document.documentElement.dataset.app || '';

/** True when the role is read-only outside Agent Dashboard (the researcher). */
export const readOnlyHere = () => (Boolean(currentPermission()?.readOnly) || (currentPermission()?.readOnlyApps || []).includes(currentApp())) && currentApp() !== 'agent-ops';

/** May the current role perform this write? interaction: create | update | transition | sign | cosign | $release | $acknowledge. */
export function canWrite(type, interaction, { orderMode = false, categories = [] } = {}) {
  if (!data) return true;
  const perm = currentPermission();
  if (!perm) return false;
  if (perm.writes === '*') return true;
  if (readOnlyHere()) return false;
  if (interaction.startsWith('$')) return perm.writes[interaction] === true;
  const list = perm.writes[type];
  if (!list) return false;
  if (interaction === 'sign') return list.includes('sign') || list.some((x) => x.startsWith('sign:') && (categories.length ? categories.includes(x.slice(5)) : true));
  return list.includes(interaction) || (interaction === 'create' && orderMode && list.includes('create:order-mode'));
}

/** True when the role may enter this order type only as a verbal, telephone or protocol order. */
export const orderModeRequired = (type) => !canWrite(type, 'create') && canWrite(type, 'create', { orderMode: true });

// A role the map does not describe cannot be filtered, so it sees every app rather than being bounced between pages.
export const canSee = (app) => { const perm = currentPermission(); return !perm || !Array.isArray(perm.apps) || perm.apps.includes(app); };

/** The role's visible EHR navigation, in the page's own order. ids: the page's nav ids. */
export function visibleNav(ids) {
  // No map yet, or a role the map does not describe: nothing to filter by, so every screen stays reachable (a page that filters to nothing can only redirect to itself).
  const perm = currentPermission();
  if (!data || !perm || !Array.isArray(perm.nav)) return ids;
  return ids.filter((id) => perm.nav.includes(id));
}

/** The role's chart tabs, in the role's order, limited to the tabs the page has built. built: the page's tab ids. */
export function visibleChartTabs(built) {
  const perm = currentPermission();
  if (!data || !perm || !Array.isArray(perm.chartTabs)) return built;
  return perm.chartTabs.filter((id) => built.includes(id));
}

export const tabReadOnly = (id) => Boolean(currentPermission()?.readOnlyTabs?.includes(id)) || readOnlyHere();

/** Where the role starts. Falls back to the EHR dashboard when the landing app is not built. */
export function landing() {
  const perm = currentPermission();
  const l = perm?.landing || { app: 'ehr', hash: '#/dashboard' };
  return isBuilt(l.app) ? l : { app: 'ehr', hash: '#/dashboard' };
}
export const landingUrl = () => { const l = landing(); return `/${l.app}/${l.hash}`; };

const plural = (label) => (label.endsWith('s') ? label : `${label}s`);
const THING = { ImagingStudy: 'imaging studies', DiagnosticReport: 'reports', Patient: 'patient records', ServiceRequest: 'orders', Communication: 'messages', Task: 'tasks', MedicationRequest: 'prescriptions', Observation: 'results', DocumentReference: 'notes', Condition: 'problems', AllergyIntolerance: 'allergies', Encounter: 'visits', Appointment: 'appointments', List: 'patient lists', Procedure: 'procedures', CarePlan: 'care plans', Goal: 'goals', Location: 'beds', MedicationDispense: 'dispense records', DetectedIssue: 'pharmacy checks' };
const VERB = { create: 'add', update: 'change', transition: 'move', sign: 'sign', cosign: 'co-sign', verify: 'verify' };

/** "Nurses cannot prescribe": the short reason shown in a disabled control's tooltip. */
export function reasonFor(type, interaction) {
  const perm = currentPermission();
  if (!data) return '';
  if (!perm) return 'Unknown role: choose a role in Work as';
  if (readOnlyHere()) return perm.readOnly ? 'Researcher is read-only outside Agent Dashboard' : `This app is read-only for ${plural(perm.label).toLowerCase()}`;
  const who = plural(perm.label);
  if (interaction === '$release') return `${who} cannot release records to the Patient Portal`;
  if (interaction === '$acknowledge') return `${who} cannot acknowledge critical results`;
  if (type === 'MedicationRequest' && interaction === 'create') return `${who} cannot prescribe${orderModeRequired(type) ? '. Enter a verbal, telephone or protocol order instead' : ''}`;
  if (type === 'ServiceRequest' && interaction === 'create') return `${who} cannot place orders${orderModeRequired(type) ? '. Enter a verbal, telephone or protocol order instead' : ''}`;
  return `${who} cannot ${VERB[interaction] || interaction} ${THING[type] || type}`;
}

/**
 * Button options for a write control: {} when allowed, { disabled, title } with the reason when not.
 * Controls are disabled, never hidden, so the screen reads the same for every role.
 */
export function gate(type, interaction, opts) {
  if (canWrite(type, interaction, opts)) return {};
  return { disabled: true, title: reasonFor(type, interaction) };
}

/** Sends the browser to the role's landing app when the current app is not one the role may open. Returns true when it navigated. */
export function leaveIfNotAllowed(app = currentApp()) {
  if (!data || canSee(app)) return false;
  const l = landing();
  // Never hand over to the page already open: that would reload for ever.
  if (l.app === app) return false;
  location.href = `/${l.app}/${l.hash}`;
  return true;
}
