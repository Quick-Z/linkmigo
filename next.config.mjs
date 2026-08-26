import { readFileSync } from "node:fs";

const privateDevOrigins = [
  "0.0.0.0",
  "10.*.*.*",
  "192.168.*.*",
  "169.254.*.*",
  "*.local",
  ...Array.from({ length: 16 }, (_, index) => `172.${index + 16}.*.*`),
];

const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

/** @type {import('next').NextConfig} */
const nextConfig = {
  allowedDevOrigins: privateDevOrigins,
  reactCompiler: true,
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
};

export default nextConfig;
