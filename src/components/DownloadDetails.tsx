import { DOWNLOAD } from "@/lib/download";
import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";

interface LatestRelease {
  version: string;
  installer: string;
  portable: string;
  releaseUrl: string;
}

function useLatestRelease(): LatestRelease {
  const [latest, setLatest] = useState<LatestRelease>({
    version: DOWNLOAD.version,
    installer: DOWNLOAD.installer,
    portable: DOWNLOAD.portable,
    releaseUrl: DOWNLOAD.release,
  });

  useEffect(() => {
    let mounted = true;
    fetch(DOWNLOAD.releaseApi, { headers: { Accept: "application/vnd.github.v3+json" } })
      .then((r) => r.json())
      .then((data) => {
        if (!mounted) return;
        const tag: string = data.tag_name || "";
        if (!tag) return;
        const assets: { name: string; browser_download_url: string }[] = data.assets || [];
        const installerAsset = assets.find((a) => a.name.toLowerCase().endsWith(".exe"));
        const zipAsset = assets.find((a) => a.name.toLowerCase().endsWith(".zip"));
        setLatest({
          version: tag.replace(/^v/i, ""),
          installer: installerAsset?.browser_download_url ?? DOWNLOAD.installer,
          portable: zipAsset?.browser_download_url ?? DOWNLOAD.portable,
          releaseUrl: data.html_url || DOWNLOAD.release,
        });
      })
      .catch(() => {/* keep fallback */});
    return () => { mounted = false; };
  }, []);

  return latest;
}

export function DownloadDetails() {
  const rel = useLatestRelease();
  return (
    <div className="download-details">
      <p>
        {DOWNLOAD.platform} · x64 / 64-bit · v{rel.version} · {DOWNLOAD.installerSize}
      </p>
      <details>
        <summary>Installation &amp; download options</summary>
        <div>
          <p>
            For 64-bit Intel or AMD Windows PCs. This download is not a native ARM64 or 32-bit build. macOS and Linux installers are not offered here.
          </p>
          <ol>
            <li>Download the Windows installer and run it.</li>
            <li>Follow the setup prompts, then open Calvras.</li>
            <li>
              Choose a project folder and describe your first task. AI features require an internet connection and configured model access.
            </li>
          </ol>
          <div className="download-options">
            <a href={rel.portable}>
              Portable ZIP · {DOWNLOAD.portableSize} <ArrowUpRight size={13} />
            </a>
            <a href={rel.releaseUrl} target="_blank" rel="noopener noreferrer">
              Release details <ArrowUpRight size={13} />
            </a>
          </div>
        </div>
      </details>
    </div>
  );
}

// Hook exported for LandingPage to get the dynamic installer URL
export { useLatestRelease };
