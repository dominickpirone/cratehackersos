/* Level 11 funnel — GA4 wiring (shared across all sales + thank-you pages).
   Loads gtag for the Crate Hackers stream, tags every hit with the visitor's
   sticky A/B/C variant, bridges the pages' existing dataLayer events to GA4
   events, and fires a conversion event (with tier + variant) on thank-you pages.
   Edit GA_ID here to change the destination property for the whole funnel. */
(function () {
  var GA_ID = 'G-WL2Q14FZTY';

  // load gtag.js (async — events queue on dataLayer until it's ready)
  var s = document.createElement('script');
  s.async = true;
  s.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_ID;
  document.head.appendChild(s);

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;
  gtag('js', new Date());

  // resolve the sticky variant: set by the sales page, else the cookie/localStorage
  function variantOf() {
    if (window.L11_VARIANT) return window.L11_VARIANT;
    var m = document.cookie.match(/(?:^|;\s*)l11_variant=([a-z])/);
    if (m) return m[1];
    try { return localStorage.getItem('l11_variant') || ''; } catch (e) { return ''; }
  }
  var variant = variantOf();

  if (variant) gtag('set', 'user_properties', { l11_variant: variant });
  gtag('config', GA_ID, variant ? { variant: variant } : {});

  // bridge the pages' existing dataLayer events into GA4 events
  function forward(o) {
    if (o && (o.event === 'l11_sales_view' || o.event === 'l11_variant_assigned')) {
      gtag('event', o.event, { variant: o.variant || variant });
    }
  }
  try { window.dataLayer.forEach(function (o) { forward(o); }); } catch (e) {}
  var _push = window.dataLayer.push;
  window.dataLayer.push = function () {
    for (var i = 0; i < arguments.length; i++) forward(arguments[i]);
    return _push.apply(window.dataLayer, arguments);
  };

  // conversion attribution on the thank-you pages (data-tier on #l11ty, or URL)
  function fireConversion() {
    var el = document.getElementById('l11ty');
    var tier = el ? (el.getAttribute('data-tier') || '') : '';
    if (!tier) {
      var p = location.pathname;
      tier = /lifetime/.test(p) ? 'lifetime' : /annual/.test(p) ? 'annual' : /monthly/.test(p) ? 'monthly' : '';
    }
    if (tier) gtag('event', 'l11_conversion', { variant: variant, tier: tier });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fireConversion);
  else fireConversion();
})();
