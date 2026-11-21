const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};
const fail = (status, code, error) => Response.json({ code, error }, { status, headers });
const clean = value => typeof value === 'string' ? value.trim() : '';

function accessDomain(value) {
  const match = /^(?:https:\/\/)?([a-z0-9-]+\.cloudflareaccess\.com)\/?$/i.exec(clean(value));
  return match ? 'https://' + match[1].toLowerCase() : null;
}

function validationError(jwt, domain, aud) {
  if (jwt?.iss !== domain) return 'RHEA_ACCESS_ISSUER';
  if (jwt.aud !== aud && !(Array.isArray(jwt.aud) && jwt.aud.includes(aud))) return 'RHEA_ACCESS_AUDIENCE';
  if (!Number.isFinite(jwt.exp) || jwt.exp <= Date.now() / 1000) return 'RHEA_ACCESS_EXPIRY';
  if (typeof jwt.sub !== 'string' || !jwt.sub.trim()) return 'RHEA_ACCESS_IDENTITY';
  return null;
}

export async function guardRhea(context, { origin, productionBranch, accessPlugin }) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!origin || !productionBranch) return fail(503, 'RHEA_DEPLOYMENT_CONFIG', 'O deploy da RHEA precisa de uma origem e branch de produção.');
  if (url.origin !== origin) return fail(403, 'RHEA_ORIGIN', 'Abra a RHEA no domínio autorizado.');

  const pagesBranch = clean(env.CF_PAGES_BRANCH);
  const runtimeBranch = clean(env.RHEA_RUNTIME_BRANCH);
  if (!pagesBranch && !runtimeBranch) {
    console.warn('[rhea-gate] runtime_branch_missing');
    return fail(503, 'RHEA_RUNTIME_BRANCH', 'A branch de produção da RHEA não está disponível nas Functions.');
  }
  if ([pagesBranch, runtimeBranch].filter(Boolean).some(branch => branch !== productionBranch)) {
    return fail(403, 'RHEA_BRANCH', 'Este deploy não corresponde à branch de produção da RHEA.');
  }

  const rawDomain = clean(env.ACCESS_TEAM_DOMAIN);
  const override = env.RHEA_ACCESS_AUD !== undefined;
  const aud = clean(override ? env.RHEA_ACCESS_AUD : env.ACCESS_AUD);
  const domain = accessDomain(rawDomain);
  const audienceValid = /^[a-zA-Z0-9_-]{20,128}$/.test(aud);
  if (!domain || !audienceValid) {
    console.warn('[rhea-gate] access_configuration_invalid', {
      teamDomainPresent: Boolean(rawDomain), teamDomainFormatValid: Boolean(domain),
      audiencePresent: Boolean(aud), audienceFormatValid: audienceValid, rheaAudienceOverride: override,
    });
    return domain
      ? fail(503, 'RHEA_ACCESS_AUD_CONFIG', 'Confira o AUD do aplicativo Access que protege a API da RHEA.')
      : fail(503, 'RHEA_ACCESS_DOMAIN_CONFIG', 'Confira o domínio da equipe Cloudflare Access nas Functions.');
  }

  const fetchSite = request.headers.get('Sec-Fetch-Site');
  const callback = url.pathname === '/api/rhea/callback' && request.method === 'GET';
  if ((request.method !== 'GET' && request.headers.get('Origin') !== origin) ||
      (fetchSite && !['same-origin', 'none'].includes(fetchSite) && !callback)) {
    return fail(403, 'RHEA_REQUEST_ORIGIN', 'Abra a operação a partir da página da RHEA.');
  }

  const assertion = request.headers.has('Cf-Access-Jwt-Assertion');
  let checkedClaims = false;
  try {
    const response = await accessPlugin({ domain, aud })({
      ...context,
      data: context.data,
      next: (...args) => {
        checkedClaims = true;
        // The plugin verifies the signature. Require complete, exact claims before allowing the route.
        const invalid = validationError(context.data?.cloudflareAccess?.JWT?.payload, domain, aud);
        if (invalid) {
          console.warn('[rhea-gate] access_claim_rejected', { code: invalid });
          return fail(403, invalid, 'O Cloudflare Access recusou a sessão deste aplicativo. Entre novamente na RHEA.');
        }
        return context.next(...args);
      },
    });
    if (checkedClaims) return response;
    if (!assertion && request.method === 'GET' &&
        ['/api/rhea/connect', '/api/rhea/callback'].includes(url.pathname) && response.status === 302) return response;
    if (!assertion) return fail(401, 'RHEA_ACCESS_SESSION', 'Entre na RHEA novamente e atualize a conexão.');
    console.warn('[rhea-gate] access_assertion_rejected');
    return fail(403, 'RHEA_ACCESS_REJECTED',
      'O Access não aceitou esta sessão. Entre novamente e, se persistir, confira o AUD do aplicativo que protege /api/rhea.');
  } catch (error) {
    if (checkedClaims) throw error;
    console.warn('[rhea-gate] access_verifier_unavailable');
    return fail(503, 'RHEA_ACCESS_VERIFIER', 'O verificador do Cloudflare Access está indisponível.');
  }
}
