const SITE_URL = "https://calvras.com";
export function marketingHead(path: string, title: string, description: string) {
  const url = `${SITE_URL}${path}`;
  return {
    meta: [
      { title }, { name: "description", content: description },
      { property: "og:title", content: title }, { property: "og:description", content: description },
      { property: "og:type", content: "website" }, { property: "og:site_name", content: "Calvras" },
      { property: "og:url", content: url }, { property: "og:image", content: `${SITE_URL}/social-preview.png` },
      { property: "og:image:width", content: "1200" }, { property: "og:image:height", content: "630" },
      { property: "og:image:alt", content: "Calvras — Build real projects with AI autonomy" },
      { name: "twitter:card", content: "summary_large_image" }, { name: "twitter:title", content: title },
      { name: "twitter:description", content: description }, { name: "twitter:image", content: `${SITE_URL}/social-preview.png` },
      { name: "twitter:image:alt", content: "Calvras — Build real projects with AI autonomy" },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}
