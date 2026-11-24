export const animeFormats = {
  TV: 'Série', TV_SHORT: 'Série curta', MOVIE: 'Filme', SPECIAL: 'Especial', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Música',
};

export const animeProviders = { anilist: 'AniList', mal: 'MyAnimeList' };
let sessionMalClientId;

export const validMalClientId = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
export function setSessionMalClientId(value) {
  sessionMalClientId = validMalClientId(value) ? value : undefined;
}

export async function lookupAnime(endpoint, title, signal, provider = 'anilist') {
  // Redirects stay manual: an expired Access session answers with a redirect to the identity provider.
  const response = await fetch(endpoint, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
    signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, ...(provider === 'mal' && {
      provider, ...(sessionMalClientId && { malClientId: sessionMalClientId }),
    }) }),
  });
  if (response.type === 'opaqueredirect' || response.status === 401) return { state: 'access_required' };
  if (response.status === 404 || response.status === 405) return { state: 'endpoint_missing' };
  if (!response.headers.get('Content-Type')?.includes('application/json')) {
    return { state: response.status === 403 ? 'access_refused' : 'unexpected_response' };
  }
  const result = await response.json().catch(() => null);
  if (!result || typeof result !== 'object') return { state: 'unexpected_response' };
  if (response.ok && result.state === 'candidates' && Array.isArray(result.candidates)) return result;
  const state = Object.hasOwn(lookupErrors, result.state) ? result.state : 'unexpected_response';
  const retryAfter = state === 'rate_limited' && Number.isInteger(result.retryAfter) &&
    result.retryAfter > 0 && result.retryAfter <= 3600 ? result.retryAfter : undefined;
  return { state, retryAfter };
}

// Every failure names what the operator can do next. Retry and manual continuation keep the selected work.
export const lookupErrors = {
  rate_limited: 'O AniList atingiu o limite de consultas. Aguarde e tente novamente.',
  invalid_title: 'Digite de 2 a 120 caracteres.',
  access_required: 'Sua sessão expirou. Entre no Private novamente e repita a busca, ou continue com o título sem metadados.',
  access_refused: 'O Cloudflare Access recusou esta sessão. Entre novamente com a conta autorizada e repita a busca.',
  not_allowed: 'O Private recusou a consulta. Recarregue a página e tente novamente.',
  endpoint_missing: 'A busca de anime ainda não está disponível nesta versão do Private. Continue com o título sem metadados.',
  provider_unconfigured: 'Cadastre seu Client ID em Configurar MyAnimeList ou preencha os metadados manualmente.',
  provider_refused: 'O AniList recusou a consulta. Tente novamente mais tarde, pesquise no site do AniList ou continue sem metadados.',
  provider_timeout: 'O AniList demorou demais para responder. Tente novamente ou continue com o título sem metadados.',
  provider_unreachable: 'A RHEA não conseguiu alcançar o AniList. Tente novamente em instantes ou continue sem metadados.',
  provider_error: 'O AniList respondeu de forma inesperada. Tente novamente ou continue com o título sem metadados.',
  provider_unavailable: 'O AniList não está disponível agora. Tente novamente mais tarde ou continue sem metadados.',
  unexpected_response: 'A RHEA recebeu uma resposta inesperada. Tente novamente ou recarregue a página.',
  network: 'Não foi possível conectar à RHEA. Verifique a conexão e tente novamente; sua seleção continua aqui.',
};

// States where repeating the search can help and the site search is a useful fallback.
export const retryableLookup = new Set(['rate_limited', 'provider_refused', 'provider_timeout', 'provider_unreachable',
  'provider_error', 'provider_unavailable', 'unexpected_response', 'network', 'access_required', 'access_refused']);
export const providerFallback = new Set(['rate_limited', 'provider_refused', 'provider_timeout', 'provider_unreachable',
  'provider_error', 'provider_unavailable']);

export function lookupMessage({ state, retryAfter }, provider = 'anilist') {
  const message = state === 'rate_limited' && retryAfter ?
    'O AniList pediu uma pausa. Tente novamente em ' + retryAfter + ' s.' : lookupErrors[state];
  if (provider !== 'mal' || !message) return message;
  return message.replaceAll('AniList', 'MyAnimeList');
}
