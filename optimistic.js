/** Run a reversible UI update before a request; always reconcile with server truth. */
export async function optimisticUpdate({ apply, request, rollback, commit = () => {}, onError = () => {} }) {
  if (typeof apply !== 'function' || typeof request !== 'function') throw new TypeError('apply and request are required');
  const snapshot = apply();
  try { const result = await request(); await commit(result); return result; }
  catch (error) {
    try { await rollback(snapshot, error); } catch (rollbackError) { console.error('Optimistic rollback failed', rollbackError); }
    onError(error); throw error;
  }
}
