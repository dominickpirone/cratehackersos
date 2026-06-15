/* Level 11 funnel — Google Tag Manager wiring (shared across sales + thank-you pages).
   Loads GTM (GTM-53P4QHG — the CrateHackers container that already holds GA4),
   exposes the visitor's sticky A/B/C variant on the dataLayer, and pushes a
   conversion event with {l11_variant, l11_tier} on the thank-you pages.

   The funnel emits three dataLayer events for you to build GTM triggers on:
     - l11_variant_assigned {variant}   (index.html, on first visit)
     - l11_sales_view       {variant}   (each sales page)
     - l11_conversion       {l11_variant, l11_tier}   (each thank-you page)
   GA4 lives inside this GTM container, so a GA4 config tag tracks page_views and
   GA4 event tags on the above events give per-variant impressions + conversions.
   Change GTM_ID here to repoint the whole funnel. */
(function (w, d) {
  var GTM_ID = 'GTM-53P4QHG';
  w.dataLayer = w.dataLayer || [];

  // resolve the sticky variant: set by the sales page, else the cookie/localStorage
  function variantOf() {
    if (w.L11_VARIANT) return w.L11_VARIANT;
    var m = d.cookie.match(/(?:^|;\s*)l11_variant=([a-z])/);
    if (m) return m[1];
    try { return w.localStorage.getItem('l11_variant') || ''; } catch (e) { return ''; }
  }
  var variant = variantOf();
  if (variant) w.dataLayer.push({ l11_variant: variant }); // expose as a GTM Data Layer Variable

  // standard GTM loader
  (function (s, l, i) {
    w[l] = w[l] || [];
    w[l].push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
    var f = d.getElementsByTagName(s)[0], j = d.createElement(s);
    j.async = true;
    j.src = 'https://www.googletagmanager.com/gtm.js?id=' + i;
    f.parentNode.insertBefore(j, f);
  })('script', 'dataLayer', GTM_ID);

  // conversion attribution on the thank-you pages (tier from #l11ty, URL fallback)
  function fireConversion() {
    var el = d.getElementById('l11ty');
    var tier = el ? (el.getAttribute('data-tier') || '') : '';
    if (!tier) {
      var p = location.pathname;
      tier = /lifetime/.test(p) ? 'lifetime' : /annual/.test(p) ? 'annual' : /monthly/.test(p) ? 'monthly' : '';
    }
    if (tier) w.dataLayer.push({ event: 'l11_conversion', l11_variant: variant, l11_tier: tier });
  }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', fireConversion);
  else fireConversion();
})(window, document);
