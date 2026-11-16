// Getting to the desktop in browser tests. Demo mode's lock screen offers "Try as" Researcher, Physician,
// Nurse or Patient. Tests that need a name, a particular patient, or one of the other roles the server knows
// enter the way an already signed-in demo browser would: the role and name are in the browser's storage.
export async function demoLogin(page, role, { name = '', patientId = null } = {}) {
  const four = ['researcher', 'physician', 'nurse', 'patient'].includes(role);
  if (four && !name && !patientId) { await page.click(`[data-testid="try-as-${role}"]`); await page.waitForSelector('[data-testid="dock"]'); return; }
  await page.evaluate(([r, n, p]) => { localStorage.setItem('hd.role', r); localStorage.setItem('hd.user', n); localStorage.setItem('hd.session', 'in'); if (p) localStorage.setItem('hd.patient', p); }, [role, name, patientId]);
  await page.reload(); await page.waitForSelector('[data-testid="dock"]');
}
