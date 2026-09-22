/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @stackd/solana ships raw TypeScript source, so Next has to compile it.
  transpilePackages: ['@stackd/solana'],
  // No page uses next/image — logos are lettered tiles and the few images are
  // plain <img> from /public — so the image optimizer serves nothing. It is
  // also where Next 14's critical advisories live (GHSA-2xp9-vwfh-vxw4), and
  // the old remotePatterns entry let it fetch from a third-party host. Off
  // until an upgrade to Next 15.5.24+ and a real need for it.
  images: { unoptimized: true },
};

export default nextConfig;
