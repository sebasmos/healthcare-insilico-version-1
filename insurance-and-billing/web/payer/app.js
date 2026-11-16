// Payer Portal: the insurer's review workbench (docs/PAYER.md 5.6). Queues sorted by time left, the three-pane
// review, claim decisions, appeals, audits and policies. The insurer sees only what the hospital sent; patients
// are shown by number. Insurer names are made up; rules, codes and prices come from the public files you loaded.
import { h, clear, initApp } from '/shared/ui.js';
import { payerBench, PAYER_QUEUES } from '/shared/insurance.js';

const root = document.getElementById('app');
const shell = await initApp({ app: 'payer', crumbs: { app: 'Payer', home: 'bench', names: { bench: 'Review workbench', ...Object.fromEntries(PAYER_QUEUES) } } });
async function render() {
  let kids;
  try { kids = await payerBench(render, location.hash.replace(/^#\/?/, '').split('/')[0] || null); } catch (err) { kids = [h('div', { class: 'card empty', testid: 'payer-error' }, err.message)]; }
  clear(root).append(h('div', { class: 'topbar' }, h('span', { class: 'appname' }, 'Payer'), h('span', { class: 'spacer' }), shell.themeToggle, shell.roleSelect),
    h('main', { class: 'content' }, h('div', { class: 'page-head' }, h('h1', {}, 'Review workbench')), h('p', { class: 'syn', testid: 'bench-note' }, 'You see only what the hospital sent. Patients are shown by number.'), ...kids));
}
window.addEventListener('hashchange', render);
render();
