import cloudflareAccessPlugin from '@cloudflare/pages-plugin-cloudflare-access';
import { guardRhea } from '../../../src/rhea/access-gate.mjs';
import { configuredOrigin } from '../../../src/rhea/deployment.mjs';

export async function onRequest(context) {
  return guardRhea(context, {
    origin: configuredOrigin(context.env),
    productionBranch: context.env.RHEA_PRODUCTION_BRANCH,
    accessPlugin: cloudflareAccessPlugin,
  });
}
