export const animeFormats = {
  TV: 'Série', TV_SHORT: 'Série curta', MOVIE: 'Filme', SPECIAL: 'Especial', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Música',
};

export async function lookupAnime(endpoint, title, signal) {
  const response = await fetch(endpoint, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  });
  const result = await response.json();
  if (response.ok && result.state === 'candidates' && Array.isArray(result.candidates)) return result;
  return { state: result.state === 'rate_limited' || result.state === 'invalid_title' ? result.state : 'unavailable' };
}

export const lookupErrors = {
  rate_limited: 'O AniList pediu uma pausa. Tente mais tarde.',
  invalid_title: 'Digite de 2 a 120 caracteres.',
  unavailable: 'A consulta está indisponível.',
};
