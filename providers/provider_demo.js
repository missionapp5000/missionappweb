// providers/provider_demo.js
// Simple static provider for testing UI & API

const IMAGE_PROXY = "https://wsrv.nl/?url=";

function proxiedPoster(url) {
  if (!url) return null;
  return IMAGE_PROXY + encodeURIComponent(url);
}

const demoMovies = [
  {
    id: "demo-1",
    type: "movie",
    title: "Demo Movie 1",
    year: 2024,
    description: "A sample movie for testing the player.",
    poster: proxiedPoster("https://via.placeholder.com/300x450?text=Demo+1"),
  },
  {
    id: "demo-2",
    type: "movie",
    title: "Demo Movie 2",
    year: 2023,
    description: "Another sample movie.",
    poster: proxiedPoster("https://via.placeholder.com/300x450?text=Demo+2"),
  },
];

module.exports = {
  id: "demo",
  name: "Demo Provider",
  supportedTypes: ["movie"],

  // Home: one section "Demo Movies"
  async getHome() {
    return [
      {
        id: this.id,
        title: "Demo Movies",
        items: demoMovies.map(m => ({
          providerId: this.id,
          id: m.id,
          type: m.type,
          title: m.title,
          year: m.year,
          poster: m.poster,
          description: m.description,
        })),
      },
    ];
  },

  async search(query) {
    const q = query.toLowerCase();
    return demoMovies
      .filter(m => m.title.toLowerCase().includes(q))
      .map(m => ({
        providerId: this.id,
        id: m.id,
        type: m.type,
        title: m.title,
        year: m.year,
        poster: m.poster,
        description: m.description,
      }));
  },

  async load(id) {
    const movie = demoMovies.find(m => m.id === id);
    if (!movie) throw new Error("Not found");

    return {
      providerId: this.id,
      id: movie.id,
      type: movie.type,
      title: movie.title,
      year: movie.year,
      description: movie.description,
      poster: movie.poster,
      tags: ["Demo", "Sample"],
      episodes: [], // for movies, empty
    };
  },

  async loadLinks(loadData) {
    // loadData will include { id, providerId, ... }
    // Here we return a single test stream (you can point to your own MP4/HLS)
    return {
      streams: [
        {
          name: "Demo 1080p",
          url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
          isM3u8: false,
          quality: 1080,
          headers: {},
        },
      ],
      subtitles: [],
    };
  },
};
