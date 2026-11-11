/** Small dependency-free observable store; immutable updates keep UI state predictable. */
export function createStore(initialState = {}) {
  let state = Object.freeze({ ...initialState });
  const listeners = new Set();
  return Object.freeze({
    getState: () => state,
    setState(update) {
      const patch = typeof update === 'function' ? update(state) : update;
      if (!patch || typeof patch !== 'object') throw new TypeError('Store update must return an object');
      state = Object.freeze({ ...state, ...patch });
      listeners.forEach(listener => listener(state));
      return state;
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('listener must be a function');
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}
export const appStore = createStore({ user: null, isAdmin: false, offers: [], tickets: [], cart: null, loading: false });
