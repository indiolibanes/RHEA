export function configuredOrigin(env) {
  try {
    const url = new URL(env.RHEA_PUBLIC_ORIGIN);
    return url.protocol === 'https:' && url.origin === env.RHEA_PUBLIC_ORIGIN ? url.origin : null;
  } catch {
    return null;
  }
}
