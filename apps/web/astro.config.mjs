import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.RHEA_PUBLIC_ORIGIN || undefined,
  output: 'static',
  markdown: { syntaxHighlight: false },
  trailingSlash: 'never',
  build: { inlineStylesheets: 'never' },
  security: {
    csp: {
      algorithm: 'SHA-256',
      scriptDirective: { resources: ["'self'"] },
      styleDirective: { resources: ["'self'"] },
      directives: [
        "default-src 'self'",
        "base-uri 'self'",
        "object-src 'none'",
        "frame-src 'none'",
        "font-src 'self' data:",
        "img-src 'self' data: blob:",
        "connect-src 'self'",
        "media-src 'self'",
        "manifest-src 'self'",
        "worker-src 'self'",
        "form-action 'self'",
        "upgrade-insecure-requests",
      ],
    },
  },
});

