import { DOWNLOAD } from "@/lib/download";
import { readRelease } from "@/lib/update";
import { ArrowUpRight } from "lucide-react";
import { useEffect, useState } from "react";

interface LatestRelease {
  version: string;
  installer: string;
  portable: string;
  releaseUrl: string;
}

const bundled: LatestRelease = {
  version: DOWNLOAD.version,
  installer: DOWNLOAD.installer,
  portable: DOWNLOAD.portable,
  releaseUrl: DOWNLOAD.release,
};

/** Quotes whatever version calvras.com says is published, and the bundled version until it answers. */
function useLatestRelease(): LatestRelease {
  const [latest, setLatest] = useState<LatestRelease>(bundled);

  useEffect(() => {
    let mounted = true;
    fetch(DOWNLOAD.feed, { headers: { accept: "application/json" } })
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then((payload) => {
        const release = readRelease(payload);
        if (mounted) setLatest({ version: release.version, installer: release.installer, portable: release.portable || bundled.portable, releaseUrl: release.release || bundled.releaseUrl });
      })
      .catch(() => {/* keep the bundled version */});
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
