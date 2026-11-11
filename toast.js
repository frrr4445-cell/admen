const DEFAULT_DURATION = 4200;
let host;
function ensureHost() {
  if (host?.isConnected) return host;
  if (!globalThis.document?.body) return null;
  host = document.getElementById('tt-toast-region');
  if (!host) {
    host = document.createElement('div');
    host.id = 'tt-toast-region';
    host.className = 'tt-toast-region';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-atomic', 'false');
    document.body.append(host);
  }
  return host;
}
export function showToast(message, type = 'info', duration = DEFAULT_DURATION) {
  const region = ensureHost();
  if (!region) return false;
  const item = document.createElement('div');
  item.className = `tt-toast tt-toast-${['success','error','warning'].includes(type) ? type : 'info'}`;
  item.textContent = String(message ?? '');
  item.setAttribute('role', type === 'error' ? 'alert' : 'status');
  region.append(item);
  requestAnimationFrame(() => item.classList.add('is-visible'));
  const timeout = Math.max(1200, Math.min(Number(duration) || DEFAULT_DURATION, 10000));
  setTimeout(() => { item.classList.remove('is-visible'); setTimeout(() => item.remove(), 220); }, timeout);
  return true;
}
if (typeof window !== 'undefined') window.showToast = showToast;

/** Promise-based accessible dialogs; avoids blocking native browser prompts. */
function openDialog({ title = 'تأكيد', message = '', value = '', inputType = null, confirmLabel = 'تأكيد', cancelLabel = 'إلغاء', danger = false } = {}) {
  if (!globalThis.document?.body) return Promise.resolve(null);
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'tt-dialog-backdrop';
    overlay.setAttribute('role', 'presentation');
    const panel = document.createElement('section');
    panel.className = 'tt-dialog';
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h2'); heading.className = 'tt-dialog-title'; heading.textContent = title;
    const copy = document.createElement('p'); copy.className = 'tt-dialog-message'; copy.textContent = message;
    panel.append(heading, copy);
    let input;
    if (inputType) {
      input = document.createElement('input'); input.className = 'tt-dialog-input'; input.type = inputType;
      input.value = String(value ?? ''); input.autocomplete = 'off';
      if (inputType === 'number') { input.step = 'any'; input.inputMode = 'decimal'; }
      panel.append(input);
    }
    const actions = document.createElement('div'); actions.className = 'tt-dialog-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'tt-dialog-cancel'; cancel.textContent = cancelLabel;
    const accept = document.createElement('button'); accept.type = 'button'; accept.className = danger ? 'tt-dialog-accept is-danger' : 'tt-dialog-accept'; accept.textContent = confirmLabel;
    actions.append(cancel, accept); panel.append(actions); overlay.append(panel); document.body.append(overlay);
    let settled = false;
    const finish = result => { if (settled) return; settled = true; document.removeEventListener('keydown', keydown); overlay.remove(); resolve(result); };
    const keydown = event => { if (event.key === 'Escape') finish(null); if (event.key === 'Enter' && input) { event.preventDefault(); finish(input.value); } };
    cancel.addEventListener('click', () => finish(null)); accept.addEventListener('click', () => finish(input ? input.value : true));
    overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
    document.addEventListener('keydown', keydown);
    (input || accept).focus();
  });
}
export const confirmDialog = (message, options = {}) => openDialog({ ...options, message, inputType: null });
export const promptDialog = (message, value = '', options = {}) => openDialog({ ...options, message, value, inputType: options.inputType || 'text' });
