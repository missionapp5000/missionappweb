// providers/provider_cinemeta.js
// Example provider that uses a public metadata catalog (like Cinemeta-style API)

const axios = require("axios");

const MAIN_URL = "https://cinemeta-catalogs.strem.io";
const AIOMETA_URL = "https://v3-cinemeta.strem.io"; // demo, metadata-like

const IMAGE_PROXY = "https://wsrv.nl/?url=";

function proxiedPoster(url) {
  if (!url) return null;
  if (url.includes("metahub.space")) {
    url = url.replace("/small/", "/large/").replace("/medium/", "/large/");
  }
  return IMAGE_PROXY + encodeURIComponent(url);
}

module.exports = {
  id: "cinemeta",
  name: "Cinemeta Demo",
  supportedTypes: ["movie", "series"],

  // Simple home: trending movies & series
  async getHome() {
    const sections = [];

    // Helper to fetch one catalog
    async function fetchCatalog(url, title) {
      const res = await axios.get(url);
      const data = res.data;
      const items = (data.metas || []).map(meta => ({
        providerId: "cinemeta",
        id: meta.id,
        type: meta.type === "series" ? "series" : "movie",
        title: meta.name || (meta.aliases && meta.aliases[0]) || "",
        year: parseInt(meta.year, 10) || null,
        poster: proxiedPoster(meta.poster),
        description: meta.description || "",
      }));
      sections.push({ id: "cinemeta", title, items });
    }

    await fetchCatalog(
      `${MAIN_URL}/top/catalog/movie/top/skip=0.json`,
      "Top Movies"
    );
    await fetchCatalog(
      `${MAIN_URL}/top/catalog/series/top/skip=0.json`,
      "Top Series"
    );

    return sections;
  },

  async search(query) {
    const urls = [
      `${AIOMETA_URL}/catalog/movie/top/search=${encodeURIComponent(query)}.json`,
      `${AIOMETA_URL}/catalog/series/top/search=${encodeURIComponent(query)}.json`,
    ];

    const all = [];

    for (const url of urls) {
      try {
        const res = await axios.get(url);
        const data = res.data;
        (data.metas || []).forEach(meta => {
          all.push({
            providerId: this.id,
            id: meta.id,
            type: meta.type === "series" ? "series" : "movie",
            title: meta.name || (meta.aliases && meta.aliases[0]) || "",
            year: parseInt(meta.year, 10) || null,
            poster: proxiedPoster(meta.poster),
            description: meta.description || "",
          });
        });
      } catch (e) {
        console.error("Cinemeta search error:", e.message);
      }
    }

    return all;
  },

  async load(id) {
    // Minimal meta fetch
    // In CineStreamProvider you decide between kitsu/cinemeta; here we do a simple one
    const type = "movie"; // or "series" — real implementation would detect based on id prefix etc.
    const url = `${AIOMETA_URL}/meta/${type}/${encodeURIComponent(id)}.json`;

    const res = await axios.get(url);
    const meta = res.data.meta;

    return {
      providerId: this.id,
      id,
      type: meta.type === "series" ? "series" : "movie",
      title: meta.name || "",
      year: parseInt(meta.year, 10) || null,
      description: meta.description || "",
      poster: proxiedPoster(meta.poster),
      tags: meta.genre || [],
      episodes: [], // you can map meta.videos to episodes later
    };
  },

  async loadLinks(loadData) {
    // For educational purposes, we do NOT scrape streams from 3rd party sites here.
    // Instead, return an empty list or a demo stream.
    return {
      streams: [],
      subtitles: [],
    };
  },
};
