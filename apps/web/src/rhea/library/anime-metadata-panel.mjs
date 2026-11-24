import { animeFormats as formats, animeProviders, lookupAnime, lookupMessage } from './anime-lookup.mjs';

const root = document.querySelector('[data-rhea-telegram-library]');
const form = root.querySelector('#anime-lookup-form');
const input = root.querySelector('#anime-title');
const submit = form.querySelector('button');
const providerChoice = form.querySelector('#anime-provider');
const status = root.querySelector('#anime-lookup-status');
const results = root.querySelector('#anime-lookup-results');
const endpoint = root.dataset.animeMetadataEndpoint;
const node = (tag, value) => Object.assign(document.createElement(tag), { textContent: value });
let active;

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

function reset() {
  active?.abort();
  active = undefined;
  submit.disabled = false;
  form.reset();
  submit.textContent = 'Buscar no AniList';
  status.textContent = '';
  results.replaceChildren();
}

providerChoice.addEventListener('change', () => {
  active?.abort();
  active = undefined;
  submit.disabled = false;
  submit.textContent = 'Buscar no ' + animeProviders[providerChoice.value];
  status.textContent = '';
  results.replaceChildren();
});

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
