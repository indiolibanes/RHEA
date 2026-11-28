import { animeProviders } from './anime-lookup.mjs';

// One metadata source for the whole Telegram tab: lookup by work, batch lookup in a letter and the preview.
// Only the provider name is remembered on this device; a MyAnimeList Client ID is never stored here.
const key = 'rhea.animeProvider';
const listeners = new Set();
let current;

function stored() {
  try {
    const value = globalThis.localStorage?.getItem(key);
    return Object.hasOwn(animeProviders, value ?? '') ? value : undefined;
  } catch {
    return undefined;
  }
}

export function animeProviderPreference() {
  current ??= stored() ?? 'mal';
  return current;
}

export function saveAnimeProvider(value) {
  if (!Object.hasOwn(animeProviders, value)) return;
  const changed = value !== animeProviderPreference();
  current = value;
  try { globalThis.localStorage?.setItem(key, value); } catch { /* Private browsing: keep it for this page. */ }
  if (changed) for (const listener of listeners) listener(value);
}

export function onAnimeProviderChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
