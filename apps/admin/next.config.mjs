/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  // The workspace packages ship TypeScript-built ESM; Next must not treat them as external.
  transpilePackages: ['@bozorlar/api-client', '@bozorlar/contracts', '@bozorlar/session', '@bozorlar/types'],
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
};
