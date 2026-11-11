/** Cross-document View Transitions are enabled progressively in tt-design.css. */
export function installPageTransitions() {
  if (typeof document === 'undefined') return false;
  document.documentElement.classList.add('tt-transitions-ready');
  return Boolean(document.startViewTransition);
}
installPageTransitions();
