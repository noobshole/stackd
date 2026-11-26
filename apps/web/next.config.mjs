/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The @stackd packages ship raw TypeScript source, so Next has to compile them.
  transpilePackages: ['@stackd/solana', '@stackd/base'],
  // No page uses next/image — logos are lettered tiles and the few images are
  // plain <img> from /public — so the image optimizer would serve nothing.
  // Off, so it is not an endpoint to defend, until there is a real need for it.
  images: { unoptimized: true },
};

export default nextConfig;
