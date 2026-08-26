import "./globals.css";

import { getAppName } from "@/lib/app-config";

export const dynamic = "force-dynamic";

const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || "unknown";

export async function generateMetadata() {
  return {
    title: getAppName(),
    description: "公开社媒资源下载工具",
  };
}

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: "console.info(\"[LinkMigo] version: \" + " + JSON.stringify(appVersion) + ");",
          }}
        />
      </body>
    </html>
  );
}
