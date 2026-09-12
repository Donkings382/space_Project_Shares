(function () {
  var current = window.SPACEX_CONFIG || {};

  window.SPACEX_CONFIG = {
    apiBase: current.apiBase || "http://localhost:4000",
    smartsuppKey: current.smartsuppKey || "REPLACE_WITH_SMARTSUPP_SITE_KEY",
  };

  window.SPACEX_SMARTSUPP_KEY = window.SPACEX_CONFIG.smartsuppKey;
})();
