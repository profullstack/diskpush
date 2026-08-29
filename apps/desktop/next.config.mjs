/** @type {import('next').NextConfig} */
const nextConfig = {
  // The renderer is loaded from disk by Electron, not served, so it is
  // exported as static files. There is no Next server in the desktop app.
  output: 'export',
  distDir: 'out',
  images: { unoptimized: true },
  reactStrictMode: true,
}

export default nextConfig
