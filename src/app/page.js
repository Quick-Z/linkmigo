import { SocialDownloaderClient } from "./social-downloader/_components/social-downloader-client";
import { getAppName, getAppTheme, getUrlPlaceholder, getUrlPlaceholderEn } from "@/lib/app-config";

const metadataDescription = "解析公开 Instagram、TikTok、抖音、小红书、快手、AcFun、Twitter/X、Bilibili、Facebook、Pinterest、Reddit、V2EX、YouTube、Pornhub 链接并展示媒体资源。";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  return {
    title: getAppName(),
    description: metadataDescription,
  };
}

export default function Home() {
  return <SocialDownloaderClient appName={getAppName()} themeName={getAppTheme()} urlPlaceholder={getUrlPlaceholder()} urlPlaceholderEn={getUrlPlaceholderEn()} />;
}
