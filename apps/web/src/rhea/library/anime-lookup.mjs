export const animeFormats = {
  TV: 'Série', TV_SHORT: 'Série curta', MOVIE: 'Filme', SPECIAL: 'Especial', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Música',
};

export async function lookupAnime(endpoint, title, signal) {
  const response = await fetch(endpoint, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }),
  });
  if (response.status === 401) return { state: 'access_required' };
  if (response.status === 403) return { state: 'not_allowed' };
  if (response.status === 404 || response.status === 405) return { state: 'endpoint_missing' };
  if (!response.headers.get('Content-Type')?.includes('application/json')) return { state: 'unexpected_response' };
  const result = await response.json().catch(() => null);
  if (!result || typeof result !== 'object') return { state: 'unexpected_response' };
  if (response.ok && result.state === 'candidates' && Array.isArray(result.candidates)) return result;
  const state = Object.hasOwn(lookupErrors, result.state) ? result.state : 'unexpected_response';
  const retryAfter = state === 'rate_limited' && Number.isInteger(result.retryAfter) &&
    result.retryAfter > 0 && result.retryAfter <= 3600 ? result.retryAfter : undefined;
  return { state, retryAfter };
}

export const lookupErrors = {
  rate_limited: 'O AniList atingiu o limite de consultas. Aguarde e tente novamente.',
  invalid_title: 'Digite de 2 a 120 caracteres.',
  access_required: 'Sua sessão expirou. Reabra o Private e entre novamente.',
  not_allowed: 'O Private recusou a consulta. Recarregue a página e tente novamente.',
  endpoint_missing: 'A busca de anime ainda não está disponível nesta versão do Private.',
  provider_refused: 'O AniList recusou a consulta. Você pode tentar novamente mais tarde.',
  provider_unavailable: 'O AniList não respondeu como esperado. Tente novamente mais tarde.',
  unexpected_response: 'A RHEA recebeu uma resposta inesperada. Recarregue a página e tente novamente.',
  network: 'Não foi possível conectar à RHEA. Verifique a conexão e tente novamente.',
};

export function lookupMessage({ state, retryAfter }) {
  return state === 'rate_limited' && retryAfter ?
    'O AniList pediu uma pausa. Tente novamente em ' + retryAfter + ' s.' : lookupErrors[state];
}
