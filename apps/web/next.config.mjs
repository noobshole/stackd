/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @stackd/solana ships raw TypeScript source, so Next has to compile it.
  transpilePackages: ['@stackd/solana'],
  images: {
    remotePatterns: [
      // xStock token logos, served by Backed Finance.
      { protocol: 'https', hostname: 'xstocks-metadata.backed.fi' },
    ],
  },
};

export default nextConfig;
