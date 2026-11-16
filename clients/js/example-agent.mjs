// A minimal outside agent (docs/BRING-YOUR-OWN-AGENT.md, path 1: your agent, your harness).
// It connects with an environment key and drives the hospital itself: the platform only gives it
// the task, the tools, the simulated world, the log and the score. Replace `decide` with your agent.
//
//   node clients/js/example-agent.mjs http://127.0.0.1:3000 hd_env_yourkey [taskId]
import { HospitalEnv } from './hospital-env.mjs';

/** Your agent goes here: one observation in, one tool call out. This one reads, looks at results, then hands back. */
export function decide(memory) {
  return async (obs, tools, info) => {
    const patientId = String(obs?.briefing?.patient || memory.patient || '').split('/')[1];
    if (obs?.briefing?.patient) memory.patient = obs.briefing.patient;
    memory.step = (memory.step || 0) + 1;
    if (memory.step === 1) return { tool: 'read-chart', args: { type: 'Patient', id: patientId }, reasoning: 'Start with who the patient is' };
    if (memory.step === 2) return { tool: 'search-results', args: { type: 'Observation', params: { patient: patientId } }, reasoning: 'Read the vital signs and results before deciding anything' };
    const seen = Array.isArray(obs?.result) ? obs.result.length : 0;
    return { tool: 'finish', args: { answer: `Read the chart and ${seen} results; no orders placed by the example agent.`, summary: 'Example agent finished' }, reasoning: 'The example agent only reads' };
  };
}

/** Runs one episode and returns the score and the links to its trace. `model` and `provider` are recorded on the run so results compare fairly. */
export async function runExampleAgent({ baseUrl, token, taskId, seed = 0, model = 'example-rules', provider = 'none' }) {
  const env = new HospitalEnv({ baseUrl, token });
  const tasks = (await env.tasks()).tasks;
  const task = taskId || tasks[0]?.id;
  if (!task) throw new Error('This key sees no tasks. Ask the platform owner to grant a task set.');
  return env.runEpisode({ task, run: 'example-run', seed, model, provider }, decide({}));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [baseUrl, token, taskId] = process.argv.slice(2);
  if (!baseUrl || !token) { console.error('Usage: node clients/js/example-agent.mjs <baseUrl> <environment key> [taskId]'); process.exit(2); }
  const out = await runExampleAgent({ baseUrl, token, taskId });
  console.log(JSON.stringify({ episode: out.episodeId, steps: out.steps, reward: out.totalReward, trace: out.links }, null, 1));
}
