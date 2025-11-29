// providers/index.js
// Central registry + safe loader

const providers = [];

function safeRegister(path) {
  try {
    const p = require(path);
    console.log("Loaded provider:", p.id || path);
    providers.push(p);
  } catch (e) {
    console.error("Failed to load provider", path, e.message);
  }
}

// Register your providers here
//safeRegister("./provider_demo");
//safeRegister("./provider_cinemeta");
safeRegister("./provider_netflix"); // <- this is the one we want to debug

function getProviders() {
  return providers;
}

function getProviderById(id) {
  return providers.find((p) => p.id === id);
}

module.exports = {
  getProviders,
  getProviderById,
};
