const express = require("express");
const session = require("express-session");
const path = require("path");
const axios = require("axios");
const crypto = require("crypto");
const { getProviders, getProviderById } = require("./providers");

const app = express();

// ===== CONFIG =====
const PORT = 9090; // Node app port
const WP_BASE = "https://netleak.nl/app";
const WP_JWT_ENDPOINT = `${WP_BASE}/wp-json/jwt-auth/v1/token`;
const WP_PLAN_CHECK = `${WP_BASE}/wp-json/netleak/v1/check-plan`;
const WP_REGISTER_URL = `${WP_BASE}/wp-json/wp/v2/users/register`;
const WP_CHECK_PHONE_URL = `${WP_BASE}/wp-json/netleak/v1/check-phone`;
const WP_REGISTER_NOTICE_URL = `${WP_BASE}/wp-json/wp/v2/register-notice`;
const WP_REGISTRATION_STATUS_URL = `${WP_BASE}/wp-json/app/v1/registration_status`;

// NEW: reset-device endpoint + token (same as your Android AuthManager.logoutUser)
const WP_RESET_DEVICE_URL = `${WP_BASE}/wp-json/jwt-auth/v1/admin-reset-device`;
const DEVICE_RESET_TOKEN =
  process.env.DEVICE_RESET_TOKEN || "resetdevice@47"; // move to env later if you want

// ===== MIDDLEWARE =====
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use(
  session({
    secret: "change-this-super-secret-key", // CHANGE THIS to something random
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }, // 1 day
  })
);

// Simple view renderer (layout + page)
const render = (res, viewName, data = {}) => {
  const fs = require("fs");
  const layout = fs.readFileSync(
    path.join(__dirname, "views/layout.html"),
    "utf8"
  );
  const body = fs.readFileSync(
    path.join(__dirname, `views/${viewName}.html`),
    "utf8"
  );
  const html = layout
    .replace("{{BODY}}", body)
    .replace(/{{TITLE}}/g, data.title || "Movies – Netleaks")
    .replace(/{{USERNAME}}/g, data.username || "")
    .replace(/{{REGISTER_MESSAGE}}/g, data.registerMessage || "");
  res.send(html);
};

// ===== HELPERS =====
function getDeviceId(req) {
  if (!req.session.deviceId) {
    // one device ID per browser session
    req.session.deviceId = "web-" + crypto.randomUUID();
  }
  return req.session.deviceId;
}

function requireLogin(req, res, next) {
  if (!req.session.wpToken) {
    return res.redirect("/login");
  }
  next();
}

function makeWpError(code, message) {
  const err = new Error(message || "Login failed");
  err.code = code || "login_failed";
  return err;
}

/**
 * Try WordPress JWT login once.
 * Does NOT do plan check; just returns the raw JWT response data (success or error).
 */
async function wpJwtLoginOnce(username, password, deviceId) {
  const resp = await axios.post(
    WP_JWT_ENDPOINT,
    {
      username,
      password,
      device_id: deviceId,
    },
    {
      headers: {
        "Content-Type": "application/json",
      },
      validateStatus: () => true, // don't throw on 4xx; we inspect body
    }
  );
  return resp.data;
}

/**
 * WordPress login with "last device wins":
 *  - If first JWT login works, return data.
 *  - If code === multiple_login_detected:
 *      - Call admin-reset-device
 *      - Retry JWT login once
 *  - Else throw error.
 */
async function wordpressLoginLastDeviceWins(username, password, deviceId) {
  // 1) First attempt
  let data = await wpJwtLoginOnce(username, password, deviceId);

  if (data && data.token) {
    return data;
  }

  if (data && data.code === "multiple_login_detected") {
    console.log(
      `WP: multiple_login_detected for ${username}, resetting previous device`
    );

    // 2) Call admin-reset-device to clear old device lock
    try {
      await axios.post(
        `${WP_RESET_DEVICE_URL}?token=${encodeURIComponent(
          DEVICE_RESET_TOKEN
        )}&username=${encodeURIComponent(username)}`,
        "",
        {
          validateStatus: () => true,
        }
      );
      console.log(`WP: reset-device called for ${username}`);
    } catch (e) {
      console.error(
        "WP reset-device error:",
        e.response?.data || e.message || e
      );
      // If reset fails, we still fall through and try login, but likely it will fail again
    }

    // 3) Retry login once
    const retryData = await wpJwtLoginOnce(username, password, deviceId);
    if (retryData && retryData.token) {
      console.log(`WP: login success after reset for ${username}`);
      return retryData;
    }

    // Retry also failed -> throw with retry's message
    throw makeWpError(
      retryData?.code || "login_failed",
      retryData?.message ||
        "Login failed even after resetting previous device session."
    );
  }

  // Any other error (wrong credentials, blocked, etc.)
  throw makeWpError(data?.code, data?.message);
}

// ===== ROUTES =====
app.get("/", (req, res) => {
  if (req.session.wpToken) {
    return res.redirect("/dashboard");
  }
  res.redirect("/login");
});

// Login form
app.get("/login", (req, res) => {
  if (req.session.wpToken) {
    return res.redirect("/dashboard");
  }
  render(res, "login", { title: "Login – Movies" });
});

// Handle login: WordPress JWT + plan check, with auto-reset on multiple_login_detected
app.post("/login", async (req, res) => {
  const { username, password, device_id } = req.body;
  if (!username || !password) {
    return res.send(
      'Username and password are required. <br><br><a href="/login">Back</a>'
    );
  }

  // Prefer browser-provided device_id (from localStorage), fallback to session/random
  let deviceId = device_id;
  if (!deviceId || typeof deviceId !== "string") {
    deviceId = getDeviceId(req);
  } else {
    req.session.deviceId = deviceId;
  }

  try {
    // 1) JWT login with "last device wins" logic
    const data = await wordpressLoginLastDeviceWins(
      username,
      password,
      deviceId
    );

    if (!data.token) {
      return res.send(
        'Login failed: token not returned from server. <br><br><a href="/login">Back</a>'
      );
    }

    const token = data.token;

    // 2) Plan check (unchanged behavior)
    const planResponse = await axios.post(
      WP_PLAN_CHECK,
      { token },
      {
        headers: {
          "Content-Type": "application/json",
        },
        validateStatus: () => true,
      }
    );

    const planData = planResponse.data || {};
    const isActive = !!planData.active;

    if (!isActive) {
      return res.send(
        'Your plan is inactive. <br><br><a href="/login">Back to login</a>'
      );
    }

    // 3) Save session (unchanged)
    req.session.wpToken = token;
    req.session.wpUser = {
      email: data.user_email,
      nicename: data.user_nicename,
      displayName: data.user_display_name,
      username,
    };
    req.session.deviceId = deviceId;

    res.redirect("/dashboard");
  } catch (err) {
    console.error("Login error:", err.code, err.message);

    // We handled multiple_login_detected internally, so if we are here it's a hard failure
    const messageFromServer = err.message;
    const code = err.code;

    let msg;
    if (code === "invalid_credentials" || code === "invalid_username") {
      msg = "Invalid username or password.";
    } else {
      msg =
        messageFromServer ||
        "Login failed. Please check your credentials or contact admin.";
    }

    res.send(`${msg} <br><br><a href="/login">Back to login</a>`);
  }
});

// Dashboard (protected)
app.get("/dashboard", requireLogin, (req, res) => {
  render(res, "dashboard", {
    title: "Dashboard – Movies",
    username:
      req.session.wpUser?.displayName || req.session.wpUser?.username || "",
  });
});

// Register page: fetch register notice and show form
app.get("/register", async (req, res) => {
  let registerMessage = "";

  try {
    const noticeRes = await axios.get(WP_REGISTER_NOTICE_URL);
    const enabled = !!noticeRes.data.enabled;
    const message = noticeRes.data.message || "";
    if (enabled && message.trim().length > 0) {
      registerMessage = message;
    }
  } catch (e) {
    console.error("Register notice error:", e.response?.data || e.message);
  }

  render(res, "register", {
    title: "Register – Movies",
    registerMessage,
  });
});

// Handle registration: check status, check phone, then create user
app.post("/register", async (req, res) => {
  const { username, email, password, phone } = req.body;

  if (!username || !email || !password || !phone) {
    return res.send(
      'All fields are required. <br><br><a href="/register">Back to register</a>'
    );
  }

  try {
    // 1) Check if registration allowed
    const statusRes = await axios.get(WP_REGISTRATION_STATUS_URL);
    const allowed = !!statusRes.data.allow_registration;
    if (!allowed) {
      return res.send(
        'Registration is currently disabled. <br><br><a href="/login">Back to login</a>'
      );
    }

    // 2) Check if phone exists
    const phoneRes = await axios.post(
      WP_CHECK_PHONE_URL,
      { phone },
      { headers: { "Content-Type": "application/json" } }
    );
    const exists = !!phoneRes.data.exists;
    if (exists) {
      return res.send(
        'Phone already registered. <br><br><a href="/register">Back to register</a>'
      );
    }

    // 3) Perform registration
    const regRes = await axios.post(
      WP_REGISTER_URL,
      {
        username,
        email,
        password,
        phone_number: phone,
      },
      { headers: { "Content-Type": "application/json" } }
    );

    if (regRes.status >= 200 && regRes.status < 300) {
      return res.send(
        'Registration successful! <br><br><a href="/login">Go to login</a>'
      );
    } else {
      const message =
        regRes.data?.message ||
        "Registration failed on server. Please try again.";
      return res.send(
        `${message} <br><br><a href="/register">Back to register</a>`
      );
    }
  } catch (err) {
    console.error("Registration error:", err.response?.data || err.message);
    const message =
      err.response?.data?.message || "Registration failed. Please try again.";
    return res.send(
      `${message} <br><br><a href="/register">Back to register</a>`
    );
  }
});

// Logout: reset device on server, then clear session
app.get("/logout", async (req, res) => {
  const user = req.session.wpUser;
  const username = user?.username;

  if (username) {
    const resetUrl = `${WP_BASE}/wp-json/jwt-auth/v1/admin-reset-device?token=resetdevice@47&username=${encodeURIComponent(
      username
    )}`;

    try {
      // Empty POST body, just like your Android code
      await axios.post(resetUrl, "");
      console.log(`Device reset for user ${username}`);
    } catch (e) {
      console.error(
        "Logout reset-device failed:",
        e.response?.data || e.message
      );
      // We still proceed to clear local session even if remote reset fails
    }
  }

  req.session.destroy(() => {
    res.redirect("/login");
  });
});

// Simple healthcheck
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// List available providers
app.get("/api/providers", requireLogin, (req, res) => {
  const providers = getProviders().map((p) => ({
    id: p.id,
    name: p.name,
    supportedTypes: p.supportedTypes,
  }));
  res.json({ providers });
});

// Combined home from all providers
app.get("/api/home", requireLogin, async (req, res) => {
  const providers = getProviders();
  const allSections = [];

  for (const p of providers) {
    try {
      const sections = await p.getHome();
      sections.forEach((sec) => {
        allSections.push({
          providerId: p.id,
          title: `${p.name} – ${sec.title}`,
          items: sec.items,
        });
      });
    } catch (e) {
      console.error(`Home error for provider ${p.id}:`, e.message);
    }
  }

  res.json({ sections: allSections });
});

// Search across providers
app.get("/api/search", requireLogin, async (req, res) => {
  const q = req.query.q || "";
  if (!q) return res.json({ results: [] });

  const providers = getProviders();
  const results = [];

  for (const p of providers) {
    try {
      const r = await p.search(q);
      results.push(...r);
    } catch (e) {
      console.error(`Search error for provider ${p.id}:`, e.message);
    }
  }

  res.json({ results });
});

// Load metadata
app.get("/api/meta/:providerId/:id", requireLogin, async (req, res) => {
  const { providerId, id } = req.params;
  const provider = getProviderById(providerId);
  if (!provider) return res.status(404).json({ error: "Provider not found" });

  try {
    const meta = await provider.load(id);
    res.json(meta);
  } catch (e) {
    console.error("Meta load error:", e.message);
    res.status(500).json({ error: "Failed to load item" });
  }
});

// Get streams (loadLinks equivalent)
app.post("/api/streams/:providerId/:id", requireLogin, async (req, res) => {
  const { providerId, id } = req.params;
  const provider = getProviderById(providerId);
  if (!provider) return res.status(404).json({ error: "Provider not found" });

  try {
    // Take title from body (like LoadData(title, id) in Kotlin)
    const title = (req.body && req.body.title) || "";

    const result = await provider.loadLinks({
      id,
      title,
    });

    res.json(result);
  } catch (e) {
    console.error("Stream load error:", e.message);
    res.status(500).json({ error: "Failed to load streams" });
  }
});





app.listen(PORT, () => {
  console.log(`Movies app running at http://localhost:${PORT}`);
});
