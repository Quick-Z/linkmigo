import "./globals.css";

export const metadata = {
  title: "LinkMigo",
  description: "公开社媒资源下载工具",
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
