// providers/provider_netflix.js
// Node.js port of CloudStream NetflixProvider with bypass(tv/p.php) support
// Fetches titles for ALL home cards using concurrency-limited requests.

const axios = require("axios");
const cheerio = require("cheerio");

const PROVIDER_ID = "netflix";
const PROVIDER_NAME = "Netflix";

const MAIN_URL = "https://net20.cc";
const NEW_URL = "https://net51.cc";
const IMAGE_CDN = "https://imgcdn.kim";
const IMAGE_PROXY = "https://wsrv.nl/?url=";

// how many parallel post.php calls we allow when filling titles on home
const HOME_FETCH_CONCURRENCY = 20;

// ---- In-memory cookie storage (NetflixMirrorStorage equivalent) ----
let tHash = ""; // t_hash_t cookie value
let tHashTimestamp = 0; // when it was obtained (ms)
const COOKIE_MAX_AGE_MS = 54_000_000; // 15 hours

/* ---------- UTILITIES ---------- */

function log(...args) {
  console.log("[Netflix]", ...args);
}

function logWarn(...args) {
  console.warn("[Netflix][WARN]", ...args);
}

function logError(...args) {
  console.error("[Netflix][ERROR]", ...args);
}

function proxied(url) {
  if (!url) return null;
  return IMAGE_PROXY + encodeURIComponent(url);
}

function unixTime() {
  return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getCookieHeader() {
  const cookies = [];
  if (tHash) cookies.push(`t_hash_t=${tHash}`);
  cookies.push("user_token=233123f803cf02184bf6c67e149cdd50");
  cookies.push("ott=nf");
  cookies.push("hd=on");
  return cookies.join("; ");
}

/* ---------- BYPASS ---------- */

async function bypass() {
  const now = Date.now();

  if (tHash && now - tHashTimestamp < COOKIE_MAX_AGE_MS) {
    log("bypass: using cached t_hash_t (age ms):", now - tHashTimestamp);
    return tHash;
  }

  tHash = "";
  tHashTimestamp = 0;

  const maxAttempts = 15;
  log("bypass: acquiring new t_hash_t via /tv/p.php ...");

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await axios.post(
        `${MAIN_URL}/tv/p.php`,
        null,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
              "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "X-Requested-With": "XMLHttpRequest",
            Referer: `${MAIN_URL}/tv/home`,
          },
          validateStatus: () => true,
        }
      );

      const text =
        typeof res.data === "string"
          ? res.data
          : JSON.stringify(res.data || {});

      log("bypass: attempt", i + 1, "status:", res.status);

      if (!text.includes('"r":"n"')) {
        log('bypass: response missing `"r":"n"`, retrying ...');
        await sleep(500);
        continue;
      }

      const setCookie = res.headers["set-cookie"] || [];
      let found = null;

      for (const c of setCookie) {
        const [pair] = c.split(";");
        const [name, value] = pair.split("=");
        if (name && name.trim() === "t_hash_t") {
          found = (value || "").trim();
          break;
        }
      }

      if (!found) {
        logWarn(
          'bypass: "r":"n" reached but no t_hash_t cookie found, retrying ...'
        );
        await sleep(500);
        continue;
      }

      tHash = found;
      tHashTimestamp = now;
      log("bypass: got t_hash_t =", tHash.slice(0, 10) + "...");
      return tHash;
    } catch (e) {
      logError("bypass error:", e.message);
      await sleep(500);
    }
  }

  throw new Error("bypass: failed to obtain t_hash_t from /tv/p.php");
}

async function ensureSession() {
  try {
    await bypass();
  } catch (e) {
    logError("ensureSession failed:", e.message);
  }
}

/* ---------- LIGHT TITLE FETCHERS FOR HOME ---------- */

async function fetchTitleForId(id) {
  await ensureSession();
  const url = `${MAIN_URL}/post.php?id=${encodeURIComponent(
    id
  )}&t=${unixTime()}`;

  try {
    const res = await axios.get(url, {
      headers: {
        Referer: `${MAIN_URL}/tv/home`,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Cookie: getCookieHeader(),
      },
      validateStatus: () => true,
    });

    if (res.status >= 400) {
      logWarn("fetchTitleForId(): HTTP", res.status, "for id", id);
      return "";
    }

    const data = res.data || {};
    const title = (data.title || "").trim();
    log("fetchTitleForId(): id =", id, "title =", `"${title}"`);
    return title;
  } catch (e) {
    logError("fetchTitleForId(): exception for id", id, e.message);
    return "";
  }
}

// Concurrency-limited title fetch for a list of ids
async function fetchTitlesForIds(ids) {
  const results = new Map();
  if (!ids.length) return results;

  const concurrency = Math.min(HOME_FETCH_CONCURRENCY, ids.length);
  let index = 0;

  log(
    "fetchTitlesForIds(): total ids =",
    ids.length,
    "concurrency =",
    concurrency
  );

  async function worker(workerId) {
    while (true) {
      const current = index++;
      if (current >= ids.length) break;
      const id = ids[current];
      log(`fetchTitlesForIds(): worker ${workerId} fetching id=${id}`);
      const title = await fetchTitleForId(id);
      if (title) results.set(id, title);
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker(i + 1));
  }

  await Promise.all(workers);

  log(
    "fetchTitlesForIds(): fetched titles for",
    results.size,
    "ids"
  );

  return results;
}

/* ---------- MAIN EXPORT ---------- */

module.exports = {
  id: PROVIDER_ID,
  name: PROVIDER_NAME,
  supportedTypes: ["movie", "series", "anime", "asianDrama"],

  /* ---------- HOME ---------- */
  async getHome() {
    log("getHome(): called");
    await ensureSession();

    try {
      const res = await axios.get(`${MAIN_URL}/home`, {
        headers: {
          Referer: `${MAIN_URL}/`,
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Cookie: getCookieHeader(),
        },
        validateStatus: () => true,
      });

      log("getHome(): HTTP status", res.status);

      if (res.status >= 400) {
        logWarn("getHome(): HTTP error", res.status);
        return [];
      }

      const html = res.data;
      const $ = cheerio.load(html);
      const sections = [];
      const rows = $(".lolomoRow");

      log("getHome(): found lolomoRow count:", rows.length);

      // id -> items that currently have empty title
      const idToItemsNeedingTitle = new Map();

      rows.each((rowIndex, row) => {
        const rowEl = $(row);
        const name =
          rowEl.find("h2 > span > div").text().trim() || "Netflix Section";

        const items = [];
        const imgs = rowEl.find("img.lazy");
        log(
          `getHome(): row[${rowIndex}] "${name}" has img.lazy count:`,
          imgs.length
        );

        imgs.each((__, img) => {
          const imgEl = $(img);

          let imgUrl = imgEl.attr("data-src") || "";
          if (!imgUrl) {
            imgUrl =
              imgEl.attr("data-original") ||
              imgEl.attr("src") ||
              "";
          }
          if (!imgUrl) {
            logWarn("getHome(): img without src/data-src ignored");
            return;
          }

          const last = imgUrl.split("/").pop() || "";
          const id = last.split(".")[0];
          if (!id) {
            logWarn("getHome(): cannot parse ID from img url:", imgUrl);
            return;
          }

          const posterUrl = `${IMAGE_CDN}/poster/v/${id}.jpg`;

          let title =
            (imgEl.attr("alt") || "").trim() ||
            (imgEl.attr("title") || "").trim() ||
            (imgEl.attr("data-title") || "").trim() ||
            (imgEl.attr("data-name") || "").trim();

          if (!title) {
            log(
              `getHome(): id=${id} has no local title; queueing for post.php`
            );
          } else {
            log(`getHome(): id=${id} local title="${title}"`);
          }

          const item = {
            providerId: PROVIDER_ID,
            id,
            type: "series",
            title,
            year: null,
            poster: proxied(posterUrl),
            description: "",
          };

          items.push(item);

          if (!title) {
            if (!idToItemsNeedingTitle.has(id)) {
              idToItemsNeedingTitle.set(id, []);
            }
            idToItemsNeedingTitle.get(id).push(item);
          }
        });

        if (items.length > 0) {
          sections.push({
            id: PROVIDER_ID,
            title: name,
            items,
          });
          log(
            `getHome(): row "${name}" -> items=${items.length}, first id=${items[0].id}`
          );
        } else {
          logWarn(`getHome(): row "${name}" produced 0 items`);
        }
      });

      const idsAll = [...idToItemsNeedingTitle.keys()];
      log(
        "getHome(): ids needing remote title from post.php =",
        idsAll.length
      );

      if (idsAll.length) {
        const titlesMap = await fetchTitlesForIds(idsAll);

        titlesMap.forEach((title, id) => {
          const items = idToItemsNeedingTitle.get(id) || [];
          items.forEach((it) => {
            it.title = title;
          });
        });
      }

      if (sections.length === 0) {
        logWarn("getHome(): parsed 0 sections from net20.cc");
      } else {
        log("getHome(): final sections:", sections.length);
      }

      return sections;
    } catch (e) {
      logError("getHome(): exception", e.message);
      return [];
    }
  },

  /* ---------- SEARCH ---------- */
  async search(query) {
    if (!query) return [];
    await ensureSession();

    log("search(): query =", query);

    try {
      const url = `${MAIN_URL}/search.php?s=${encodeURIComponent(
        query
      )}&t=${unixTime()}`;

      const res = await axios.get(url, {
        headers: {
          Referer: `${MAIN_URL}/tv/home`,
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Cookie: getCookieHeader(),
        },
        validateStatus: () => true,
      });

      log("search(): HTTP status", res.status);

      if (res.status >= 400) {
        logWarn("search(): HTTP error", res.status);
        return [];
      }

      const data = res.data; // SearchData
      const searchResults = data?.searchResult || [];
      log("search(): results count =", searchResults.length);

      return searchResults.map((it, idx) => {
        log(
          `search(): result[${idx}] id=${it.id}, title="${it.t || ""}"`
        );
        return {
          providerId: PROVIDER_ID,
          id: it.id,
          type: "series",
          title: it.t,
          year: null,
          poster: proxied(`${IMAGE_CDN}/poster/v/${it.id}.jpg`),
          description: "",
        };
      });
    } catch (e) {
      logError("search(): exception", e.message);
      return [];
    }
  },

  /* ---------- LOAD (metadata + episodes) ---------- */
  async load(id) {
    await ensureSession();

    log("load(): id =", id);

    try {
      const url = `${MAIN_URL}/post.php?id=${encodeURIComponent(
        id
      )}&t=${unixTime()}`;

      const res = await axios.get(url, {
        headers: {
          Referer: `${MAIN_URL}/tv/home`,
          "X-Requested-With": "XMLHttpRequest",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Cookie: getCookieHeader(),
        },
        validateStatus: () => true,
      });

      log("load(): HTTP status", res.status);

      if (res.status >= 400) {
        throw new Error(`HTTP ${res.status}`);
      }

      const data = res.data; // PostData
      log("load(): title =", data.title, "year =", data.year);

      const title = data.title || "";
      const cast = (data.cast || "")
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c.length > 0);

      const genres =
        (data.genre || "")
          .split(",")
          .map((g) => g.trim())
          .filter((g) => g.length > 0) || [];

      const rating = (data.match || "").replace("IMDb ", "").trim();
      const year = parseInt(data.year, 10) || null;
      const runTime = convertRuntimeToMinutes(data.runtime?.toString() || "");

      const recommendations = (data.suggest || []).map((s, idx) => {
        const recTitle = (s.t || "").trim() || `ID ${s.id}`;
        log(
          `load(): recommendation[${idx}] id=${s.id}, title="${recTitle}"`
        );
        return {
          providerId: PROVIDER_ID,
          id: s.id,
          type: "series",
          title: recTitle,
          year: null,
          poster: proxied(`${IMAGE_CDN}/poster/v/${s.id}.jpg`),
          description: "",
        };
      });

      const episodes = [];
      const firstEp = (data.episodes || [])[0];

      if (!firstEp) {
        log("load(): treated as Movie (no first episode)");
        episodes.push({
          id,
          providerId: PROVIDER_ID,
          title,
          season: null,
          episode: null,
          poster: proxied(`${IMAGE_CDN}/poster/v/${id}.jpg`),
          runtime: runTime,
        });
      } else {
        log(
          "load(): treated as Series; base episodes count:",
          (data.episodes || []).length
        );

        (data.episodes || [])
          .filter(Boolean)
          .forEach((ep, idx) => {
            const season =
              parseInt((ep.s || "").replace("S", ""), 10) || null;
            const epNum =
              parseInt((ep.ep || "").replace("E", ""), 10) || null;
            const epRuntime =
              parseInt((ep.time || "").replace("m", ""), 10) || null;

            log(
              `load(): base ep[${idx}] id=${ep.id}, s=${season}, e=${epNum}, title="${ep.t}"`
            );

            episodes.push({
              id: ep.id,
              providerId: PROVIDER_ID,
              title: ep.t,
              season,
              episode: epNum,
              poster: proxied(`${IMAGE_CDN}/epimg/150/${ep.id}.jpg`),
              runtime: epRuntime,
            });
          });

        if (data.nextPageShow === 1 && data.nextPageSeason) {
          log(
            "load(): nextPageShow=1, loading more episodes for season",
            data.nextPageSeason
          );
          const more = await getEpisodesForSeason(
            title,
            id,
            data.nextPageSeason,
            2
          );
          episodes.push(...more);
        }

        if (Array.isArray(data.season)) {
          const seasons = data.season.slice(0, -1);
          log("load(): additional seasons count:", seasons.length);
          for (const s of seasons) {
            log("load(): loading episodes for season id=", s.id);
            const more = await getEpisodesForSeason(title, id, s.id, 1);
            episodes.push(...more);
          }
        }
      }

      const type = firstEp ? "series" : "movie";

      log(
        "load(): final episodes count=",
        episodes.length,
        "type=",
        type,
        "rating=",
        rating
      );

      return {
        providerId: PROVIDER_ID,
        id,
        type,
        title,
        year,
        description: data.desc || "",
        poster: proxied(`${IMAGE_CDN}/poster/v/${id}.jpg`),
        backgroundPoster: proxied(`${IMAGE_CDN}/poster/h/${id}.jpg`),
        tags: genres,
        actors: cast,
        score: rating ? parseFloat(rating) : null,
        duration: runTime,
        contentRating: data.ua || "",
        recommendations,
        episodes,
      };
    } catch (e) {
      logError("load(): exception", e.message);
      throw e;
    }
  },

  /* ---------- LOAD LINKS ---------- */
async loadLinks(loadData) {
  await ensureSession();
  const { id, title } = loadData;
  log("loadLinks(): id =", id, "title =", title);
  try {
    // Construct the playlist URL without encoding the title
    const url = `${NEW_URL}/tv/playlist.php?id=${id}&t=${title}&tm=${unixTime()}`;
    const res = await axios.get(url, {
      headers: {
        Referer: `${MAIN_URL}/home`,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        // Use cookies similar to Kotlin (t_hash_t, ott=nf, hd=on). If getCookieHeader includes user_token,
        // you could remove it here or adjust getCookieHeader to omit user_token.
        Cookie: getCookieHeader(),
      },
      validateStatus: () => true,
    });

    log("loadLinks(): HTTP status", res.status);
    if (res.status >= 400) {
      logWarn("loadLinks(): HTTP error", res.status);
      return { streams: [], subtitles: [] };
    }

    const playlist = res.data; // PlayList (JSON)
    const streams = [], subtitles = [];
    (playlist || []).forEach(item => {
      (item.sources || []).forEach(src => {
        const finalUrl = `${NEW_URL}${src.file.replace("/tv/", "/")}`;
        const quality = getQualityFromFile(src.file);
        streams.push({
          name: src.label || "Source",
          url: finalUrl,
          isM3u8: true,
          quality,
          headers: {
            Referer: `${NEW_URL}/`,
            "User-Agent": "Mozilla/5.0 (Android) ExoPlayer",
            Accept: "*/*",
            "Accept-Encoding": "identity",
            Connection: "keep-alive",
            Cookie: "hd=on",
          },
        });
      });
      (item.tracks || [])
        .filter(t => t.kind === "captions")
        .forEach(track => {
          subtitles.push({
            label: track.label || "Subtitles",
            url: track.file,
            lang: track.language || "Unknown",
            headers: { Referer: `${NEW_URL}/` },
          });
        });
    });

    log("loadLinks(): total streams=", streams.length, "subtitles=", subtitles.length);
    return { streams, subtitles };
  } catch (e) {
    logError("loadLinks(): exception", e.message);
    return { streams: [], subtitles: [] };
  }
},

};

/* ---------- HELPERS ---------- */

function getQualityFromFile(fileUrl) {
  try {
    const qParam = fileUrl.split("q=")[1]?.split("&")[0];
    const q = parseInt(qParam, 10);
    if (!isNaN(q)) return q;
  } catch (e) {
    // ignore
  }
  return 720;
}

function convertRuntimeToMinutes(runtime) {
  let total = 0;
  const parts = (runtime || "").split(" ");
  for (const part of parts) {
    if (part.endsWith("h")) {
      const h = parseInt(part.slice(0, -1).trim(), 10);
      if (!isNaN(h)) total += h * 60;
    } else if (part.endsWith("m")) {
      const m = parseInt(part.slice(0, -1).trim(), 10);
      if (!isNaN(m)) total += m;
    }
  }
  return total;
}

async function getEpisodesForSeason(title, eid, sid, startPage) {
  await ensureSession();

  const episodes = [];
  let page = startPage;

  log(
    "getEpisodesForSeason(): title=",
    title,
    "eid=",
    eid,
    "sid=",
    sid,
    "startPage=",
    startPage
  );

  while (true) {
    const url = `${MAIN_URL}/episodes.php?s=${encodeURIComponent(
      sid
    )}&series=${encodeURIComponent(eid)}&t=${unixTime()}&page=${page}`;

    const res = await axios.get(url, {
      headers: {
        Referer: `${MAIN_URL}/tv/home`,
        "X-Requested-With": "XMLHttpRequest",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Cookie: getCookieHeader(),
      },
      validateStatus: () => true,
    });

    log(
      "getEpisodesForSeason(): HTTP status",
      res.status,
      "page",
      page
    );

    if (res.status >= 400) {
      logWarn("getEpisodesForSeason(): HTTP error", res.status);
      break;
    }

    const data = res.data; // EpisodesData
    const eps = data.episodes || [];
    log(
      "getEpisodesForSeason(): page",
      page,
      "episodes count=",
      eps.length
    );

    eps.forEach((ep, idx) => {
      const season =
        parseInt((ep.s || "").replace("S", ""), 10) || null;
      const epNum =
        parseInt((ep.ep || "").replace("E", ""), 10) || null;
      const epRuntime =
        parseInt((ep.time || "").replace("m", ""), 10) || null;

      log(
        `getEpisodesForSeason():   ep[${idx}] id=${ep.id}, s=${season}, e=${epNum}, title="${ep.t}"`
      );

      episodes.push({
        id: ep.id,
        providerId: PROVIDER_ID,
        title: ep.t,
        season,
        episode: epNum,
        poster: proxied(`${IMAGE_CDN}/epimg/150/${ep.id}.jpg`),
        runtime: epRuntime,
      });
    });

    if (data.nextPageShow === 0) {
      log("getEpisodesForSeason(): nextPageShow=0, stop");
      break;
    }
    page++;
  }

  log(
    "getEpisodesForSeason(): total collected episodes=",
    episodes.length
  );

  return episodes;
}
