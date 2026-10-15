import { DOWNLOAD } from "@/lib/download";
import { ArrowUpRight } from "lucide-react";
export function DownloadDetails() {
  return <div className="download-details"><p>{DOWNLOAD.platform} · x64 / 64-bit · v{DOWNLOAD.version} · {DOWNLOAD.installerSize}</p><details><summary>Installation & download options</summary><div><p>For 64-bit Intel or AMD Windows PCs. This download is not a native ARM64 or 32-bit build. macOS and Linux installers are not offered here.</p><ol><li>Download the Windows installer and run it.</li><li>Follow the setup prompts, then open Calvras.</li><li>Choose a project folder and describe your first task. AI features require an internet connection and configured model access.</li></ol><div className="download-options"><a href={DOWNLOAD.portable}>Portable ZIP · {DOWNLOAD.portableSize} <ArrowUpRight size={13}/></a><a href={DOWNLOAD.release} target="_blank" rel="noopener noreferrer">Release details <ArrowUpRight size={13}/></a></div></div></details></div>;
}
