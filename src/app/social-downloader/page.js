import { SocialDownloaderClient } from "./_components/social-downloader-client";

export const metadata = {
  title: "LinkMigo",
  description: "解析公开 Instagram、TikTok、Twitter/X、Bilibili、Facebook 链接并展示媒体资源。",
};

export default function SocialDownloaderPage() {
  return <SocialDownloaderClient />;
}
