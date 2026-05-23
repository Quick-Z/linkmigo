import { SocialDownloaderClient } from "./social-downloader/_components/social-downloader-client";

export const metadata = {
  title: "LinkMigo",
  description: "解析公开 Instagram、TikTok、抖音、小红书、快手、AcFun、Twitter/X、Bilibili、Facebook、Pinterest、Reddit、V2EX、YouTube、Pornhub 链接并展示媒体资源。",
};

export default function Home() {
  return <SocialDownloaderClient />;
}
