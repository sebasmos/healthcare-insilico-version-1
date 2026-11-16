// Built-in AI features with on/off switches: the AI features hospitals use
// today, each filled by whichever agent is picked, plus the research capabilities. The built-in
// rule-based agents are the defaults, so every feature works offline. The settings in force are
// recorded on every run.
import { HttpError } from '../../platform/server/http.mjs';
import { recordAction } from '../../platform/server/audit.mjs';
import { RESEARCH } from './capabilities.mjs';
import { LEVELS } from './permissions.mjs';

export const FEATURES = [
  { id: 'draft-reply', label: 'Drafted replies to patient messages', capability: 'triage-message', defaultAgent: 'inbox-triager', when: 'When a patient message arrives' },
  { id: 'chart-summary', label: 'Chart summary', capability: 'chart-summary', defaultAgent: 'chart-summariser', when: 'When a chart is opened' },
  { id: 'ambient-note', label: 'Ambient scribe (draft note) and queued orders', capability: 'scribe-note', defaultAgent: 'note-scribe', when: 'When a visit recording stops' },
  { id: 'chart-chat', label: 'Chart chat (ask the agent about the patient)', capability: null, defaultAgent: null, when: 'When someone asks in the Agent panel' },
  { id: 'draft-report', label: 'Drafted imaging reports', capability: 'draft-report', defaultAgent: 'report-drafter', when: 'When a study is opened to read' },
];
const RESEARCH_LABEL = { 'agent-may-ask': 'Agent may ask', 'multi-step': 'Multi-step', 'autonomous-task': 'Autonomous task', 'proactive-alerts': 'Proactive alerts', 'cross-app': 'Cross-app', 'long-horizon': 'Long horizon' };
export const RESEARCH_SWITCHES = RESEARCH.map((c) => ({ id: c.id, label: RESEARCH_LABEL[c.id] || c.id, description: c.adds || '' }));
const DOC_ID = 'default';

export const defaults = () => ({
  features: Object.fromEntries(FEATURES.map((f) => [f.id, { on: true, agentId: f.defaultAgent, permission: 'read-propose' }])),
  research: Object.fromEntries(RESEARCH_SWITCHES.map((c) => [c.id, true])),
});
export async function readFeatures(reader) {
  const d = defaults(); const saved = await reader.get('AiFeatures', DOC_ID);
  if (!saved) return d;
  for (const f of FEATURES) if (saved.features?.[f.id]) d.features[f.id] = { ...d.features[f.id], ...saved.features[f.id] };
  for (const c of RESEARCH_SWITCHES) if (typeof saved.research?.[c.id] === 'boolean') d.research[c.id] = saved.research[c.id];
  return d;
}
/** The short form stored on every run, so results under different settings are never mixed. */
export const snapshot = (s) => ({ features: Object.fromEntries(Object.entries(s.features).map(([k, v]) => [k, v.on ? `${v.agentId ?? 'default'}:${v.permission}` : 'off'])), researchOff: Object.entries(s.research).filter(([, on]) => !on).map(([k]) => k) });
export const featureForCapability = (capability) => FEATURES.find((f) => f.capability === capability) || null;

export function createAiFeatures({ store }) {
  async function put(body, actor) {
    return store.transaction(async (tx) => {
      const current = await readFeatures(tx);
      for (const [id, v] of Object.entries(body?.features || {})) {
        const f = FEATURES.find((x) => x.id === id);
        if (!f) throw new HttpError(422, `Unknown AI feature "${id}". Features: ${FEATURES.map((x) => x.id).join(', ')}`);
        const next = { ...current.features[id] };
        if (typeof v.on === 'boolean') next.on = v.on;
        if (v.permission != null) { if (!LEVELS.includes(v.permission) || v.permission === 'none') throw new HttpError(422, 'permission must be read-only, read-propose or read-write'); next.permission = v.permission; }
        if (v.agentId !== undefined) {
          if (v.agentId === null || v.agentId === '') next.agentId = f.defaultAgent;
          else { const agent = await tx.get('Agent', String(v.agentId)); if (!agent) throw new HttpError(422, `Agent "${v.agentId}" is not registered`); next.agentId = agent.id; }
        }
        current.features[id] = next;
      }
      for (const [id, on] of Object.entries(body?.research || {})) {
        if (!(id in current.research)) throw new HttpError(422, `Unknown research capability "${id}"`);
        current.research[id] = Boolean(on);
      }
      const { _seq, meta, ...prev } = (await tx.get('AiFeatures', DOC_ID)) || {};
      await tx.save('AiFeatures', { ...prev, resourceType: 'AiFeatures', id: DOC_ID, ...current, updatedAt: tx.now() }, { updatedBy: actor.role });
      await recordAction(tx, { actor, kind: 'update', action: 'ai-features.set', args: snapshot(current), entityRef: `AiFeatures/${DOC_ID}`, description: 'AI feature switches changed' });
      return current;
    });
  }
  return {
    read: () => readFeatures(store), put,
    async handle(req, url, body, ctx, parts) {
      if (parts[0] !== 'ai-features') return null;
      if (req.method === 'GET') return { status: 200, body: { ...(await readFeatures(store)), catalogue: FEATURES, researchCatalogue: RESEARCH_SWITCHES, levels: LEVELS.filter((l) => l !== 'none') } };
      if (req.method === 'PUT') { if (ctx.actor.kind !== 'human') throw new HttpError(403, 'Only people can change the AI feature switches'); return { status: 200, body: await put(body, ctx.actor) }; }
      throw new HttpError(405, `${req.method} is not available for AI features`);
    },
  };
}
