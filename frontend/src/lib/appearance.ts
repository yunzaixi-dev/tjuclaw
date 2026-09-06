import { useSyncExternalStore } from 'react';

export type Mode = 'system' | 'light' | 'dark';
export type Accent = 'mono' | 'blue';
type Preferences = { mode: Mode; accent: Accent };
const key = 'tjuclaw.appearance.v1';
const defaults: Preferences = { mode: 'system', accent: 'mono' };
let canPersist = true;

export function parseAppearance(raw: string | null): Preferences {
  try {
    const value = JSON.parse(raw || '{}');
    return {
      mode: ['system', 'light', 'dark'].includes(value?.mode) ? value.mode : defaults.mode,
      accent: ['mono', 'blue'].includes(value?.accent) ? value.accent : defaults.accent,
    };
  } catch { return { ...defaults }; }
}

function readPreferences() {
  try { const value = localStorage.getItem(key); canPersist = true; return parseAppearance(value); }
  catch { canPersist = false; return { ...defaults }; }
}
const media = window.matchMedia('(prefers-color-scheme: dark)');
function resolve(preferences: Preferences) {
  return { ...preferences, canPersist, resolved: preferences.mode === 'system' ? (media.matches ? 'dark' : 'light') : preferences.mode };
}
let snapshot = resolve(readPreferences());
const listeners = new Set<() => void>();
function apply() {
  const root = document.documentElement;
  root.dataset.theme = snapshot.resolved;
  root.dataset.accent = snapshot.accent;
  root.style.colorScheme = snapshot.resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', snapshot.resolved === 'dark' ? '#101010' : '#fafafa');
  listeners.forEach(listener => listener());
}
// Runs before the product's first render; no inline script or native CSP exception.
apply();

function subscribe(listener: () => void) {
  listeners.add(listener);
  const systemChanged = () => { snapshot = resolve(snapshot); apply(); };
  const storageChanged = (event: StorageEvent) => {
    if (event.key === key || event.key === null) { snapshot = resolve(readPreferences()); apply(); }
  };
  media.addEventListener('change', systemChanged);
  window.addEventListener('storage', storageChanged);
  return () => {
    listeners.delete(listener);
    media.removeEventListener('change', systemChanged);
    window.removeEventListener('storage', storageChanged);
  };
}
export function setAppearance(patch: Partial<Preferences>) {
  const preferences = parseAppearance(JSON.stringify({ ...snapshot, ...patch }));
  try { localStorage.setItem(key, JSON.stringify(preferences)); canPersist = true; }
  catch { canPersist = false; }
  snapshot = resolve(preferences);
  apply();
}
export function useAppearance() {
  return useSyncExternalStore(subscribe, () => snapshot);
}
