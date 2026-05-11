const privateDevOrigins = [
  "0.0.0.0",
  "10.*.*.*",
  "192.168.*.*",
  "169.254.*.*",
  "*.local",
  ...Array.from({ length: 16 }, (_, index) => `172.${index + 16}.*.*`),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: privateDevOrigins,
  reactCompiler: true,
};

export default nextConfig;
