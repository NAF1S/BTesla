/** @type {import('next').NextConfig} */
const apiTarget = process.env.API_PROXY_TARGET ?? "http://localhost:4000";

const nextConfig = {
  async rewrites() {
    // Proxy /api/* to the Express server so the browser stays same-origin.
    return [{ source: "/api/:path*", destination: `${apiTarget}/api/:path*` }];
  },
};

export default nextConfig;
