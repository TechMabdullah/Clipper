import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@clipper/shared-types'],
  serverExternalPackages: ['@react-pdf/renderer', 'firebase-admin'],
  images: {
    remotePatterns: [
      { protocol: 'https', hostname: '**.googleusercontent.com' },
      { protocol: 'https', hostname: 'avatars.githubusercontent.com' },
      { protocol: 'https', hostname: 'static-cdn.jtvnw.net' },
      { protocol: 'https', hostname: 'files.kick.com' },
      { protocol: 'https', hostname: 'i.ytimg.com' },
    ],
  },
};

export default nextConfig;
