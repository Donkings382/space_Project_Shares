(function () {
  var current = window.SPACEX_CONFIG || {};
  var isLocalHost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  var defaultApiBase = isLocalHost
    ? "http://localhost:4000"
    : "https://spacex-backend-yxlo.onrender.com";

  window.SPACEX_CONFIG = {
    apiBase: current.apiBase || defaultApiBase,
    smartsuppKey: current.smartsuppKey || "REPLACE_WITH_SMARTSUPP_SITE_KEY",
  };

  window.SPACEX_SMARTSUPP_KEY = window.SPACEX_CONFIG.smartsuppKey;
})();
