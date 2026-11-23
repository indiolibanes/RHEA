const root = document.querySelector('[data-rhea-telegram-library]');
const form = root.querySelector('#anime-lookup-form');
const input = root.querySelector('#anime-title');
const submit = form.querySelector('button');
const status = root.querySelector('#anime-lookup-status');
const results = root.querySelector('#anime-lookup-results');
const endpoint = root.dataset.animeMetadataEndpoint;
const formats = { TV: 'Série', TV_SHORT: 'Série curta', MOVIE: 'Filme', SPECIAL: 'Especial', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Música' };
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
  const summary = [formats[candidate.format], candidate.year, candidate.episodes && candidate.episodes + ' ep.'].filter(Boolean);
  if (summary.length) card.append(node('p', summary.join(' · ')));
  if (candidate.studios.length) card.append(node('p', 'Estúdio · ' + candidate.studios.join(', ')));
  if (candidate.genres.length) card.append(node('p', 'Gêneros · ' + candidate.genres.join(', ')));
  const links = document.createElement('div');
  links.className = 'library-actions';
  links.append(link('Ver no AniList', candidate.url));
  if (candidate.cover) links.append(link('Abrir capa', candidate.cover));
  card.append(links);
  return card;
}

function reset() {
  active?.abort();
  active = undefined;
  submit.disabled = false;
  form.reset();
  status.textContent = '';
  results.replaceChildren();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (active) return;
  const request = new AbortController();
  active = request;
  submit.disabled = true;
  status.textContent = 'Consultando o AniList…';
  results.replaceChildren();
  try {
    const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: request.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: input.value }) });
    const result = await response.json();
    if (request.signal.aborted) return;
    if (!response.ok || result.state !== 'candidates') {
      status.textContent = result.state === 'rate_limited' ? 'O AniList pediu uma pausa. Tente mais tarde.' :
        result.state === 'invalid_title' ? 'Digite de 2 a 120 caracteres.' : 'A consulta está indisponível.';
      return;
    }
    results.replaceChildren(...result.candidates.map(show));
    status.textContent = result.candidates.length ? 'Confira a obra e a temporada entre os resultados.' : 'Nenhuma obra encontrada.';
  } catch {
    if (!request.signal.aborted) status.textContent = 'A consulta está indisponível.';
  } finally {
    if (active === request) { active = undefined; submit.disabled = false; }
  }
});

root.addEventListener('rhea:telegram-hide', reset);
window.addEventListener('pagehide', reset);
