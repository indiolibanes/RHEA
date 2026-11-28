import { animeFormats as formats, animeProviders, lookupAnime, lookupMessage,
  setSessionMalClientId, validMalClientId } from './anime-lookup.mjs';
import { animeProviderPreference, onAnimeProviderChange, saveAnimeProvider } from './anime-provider-preference.mjs';

const root = document.querySelector('[data-rhea-telegram-library]');
const form = root.querySelector('#anime-lookup-form');
const input = root.querySelector('#anime-title');
const submit = form.querySelector('button');
const providerChoice = form.querySelector('#anime-provider');
form.querySelector('#anime-example').addEventListener('click', () => {
  input.value = input.placeholder;
  input.focus();
});
const status = root.querySelector('#anime-lookup-status');
const results = root.querySelector('#anime-lookup-results');
const endpoint = root.dataset.animeMetadataEndpoint;
const node = (tag, value) => Object.assign(document.createElement(tag), { textContent: value });
let active;
const credentialForm = root.querySelector('#mal-client-form');
const credential = root.querySelector('#mal-client-id');
const clearCredential = root.querySelector('#mal-client-clear');
const credentialStatus = root.querySelector('#mal-client-status');

function clearMalCredential() {
  setSessionMalClientId(undefined);
  credentialForm.reset();
  clearCredential.hidden = true;
  credentialStatus.textContent = 'Use o Client ID do aplicativo cadastrado no MyAnimeList.';
}

credentialForm.addEventListener('submit', event => {
  event.preventDefault();
  const value = credential.value.trim();
  if (!validMalClientId(value)) return;
  setSessionMalClientId(value);
  credentialForm.reset();
  clearCredential.hidden = false;
  credentialStatus.textContent = 'Client ID pronto para usar enquanto a aba Telegram estiver aberta. O MyAnimeList passou a ser a fonte dos metadados.';
  // Choosing to configure MyAnimeList is choosing it as the source; pending lookups continue with it.
  saveAnimeProvider('mal');
  root.dispatchEvent(new Event('rhea:mal-client-ready'));
});
clearCredential.addEventListener('click', clearMalCredential);
root.addEventListener('rhea:telegram-hide', clearMalCredential);
window.addEventListener('pagehide', clearMalCredential);

function link(text, url) {
  const anchor = node('a', text);
  Object.assign(anchor, { href: url, target: '_blank', rel: 'noopener noreferrer' });
  return anchor;
}

function show(candidate) {
  const card = document.createElement('article');
  card.append(node('h3', candidate.titles[0]));
  if (candidate.titles.length > 1) card.append(node('p', candidate.titles.slice(1).join(' · ')));
  const summary = [formats[candidate.format], candidate.year, candidate.episodes && candidate.episodes + ' ep.',
    candidate.duration && candidate.duration + ' min por episódio'].filter(Boolean);
  if (summary.length) card.append(node('p', summary.join(' · ')));
  if (candidate.studios.length) card.append(node('p', 'Estúdio · ' + candidate.studios.join(', ')));
  if (candidate.genres.length) card.append(node('p', 'Gêneros · ' + candidate.genres.join(', ')));
  const links = document.createElement('div');
  links.className = 'library-actions';
  links.append(link('Ver no ' + animeProviders[candidate.provider ?? 'anilist'], candidate.url));
  if (candidate.cover) links.append(link('Abrir capa', candidate.cover));
  card.append(links);
  return card;
}

function useProvider(value) {
  providerChoice.value = value;
  submit.textContent = 'Buscar no ' + animeProviders[value];
}

function reset() {
  active?.abort();
  active = undefined;
  submit.disabled = false;
  form.reset();
  useProvider(animeProviderPreference());
  status.textContent = '';
  results.replaceChildren();
}

function changeProvider(value) {
  active?.abort();
  active = undefined;
  submit.disabled = false;
  useProvider(value);
  status.textContent = '';
  results.replaceChildren();
}

providerChoice.addEventListener('change', () => saveAnimeProvider(providerChoice.value));
onAnimeProviderChange(changeProvider);
useProvider(animeProviderPreference());

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (active) return;
  const request = new AbortController();
  active = request;
  submit.disabled = true;
  const provider = providerChoice.value;
  status.textContent = 'Consultando o ' + animeProviders[provider] + '…';
  results.replaceChildren();
  try {
    const result = await lookupAnime(endpoint, input.value, request.signal, provider);
    if (request.signal.aborted) return;
    if (result.state !== 'candidates') {
      status.textContent = lookupMessage(result, provider);
      return;
    }
    results.replaceChildren(...result.candidates.map(show));
    status.textContent = result.candidates.length ? 'Confira a obra e a temporada entre os resultados.' : 'Nenhuma obra encontrada.';
  } catch {
    if (!request.signal.aborted) status.textContent = lookupMessage({ state: 'network' });
  } finally {
    if (active === request) { active = undefined; submit.disabled = false; }
  }
});

root.addEventListener('rhea:telegram-hide', reset);
window.addEventListener('pagehide', reset);
