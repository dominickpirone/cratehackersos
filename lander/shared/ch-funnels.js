/* Chicago + Hackathon funnels — first-party pixel → Crate Hackers OS  +  GA4 (via GTM).

   Drop ONE tag on each lander page (after GTM is fine):
     <script src="/shared/ch-funnels.js" data-funnel="chicagohackathon" data-page="optin"></script>

   data-funnel : which funnel this page belongs to. Use the SAME id on a funnel's
                 opt-in AND thank-you page so they aggregate together:
                   chicagohackathon  → /chicagohackathon (opt-in) + /chicagohackathon-ty (TY)
                   chicago           → /chicago (in-person opt-in) + /chicago-ty (TY)
                   hackathon-popo    → /hackathon-popo (opt-in) + /hackathon-popo-ty (TY)
   data-page   : "optin" → fires `view` on load + `cta` on any Kartra checkout/opt-in click
                 "ty"    → fires `conv` on load (= one confirmed LEAD / opt-in)
                 (omitted → auto-detected from the URL: *-ty / thank-you ⇒ ty)
   data-variant-cookie : (optional) name of a cookie holding an A/B variant id
                 (e.g. "popo_variant" = jewel|storm). When present its value is sent
                 as the funnel VARIANT — i.e. the `v` param the OS /api/funnel already
                 groups by — so the funnel breaks down per option with NO backend
                 change. A ?v=<variant> query param overrides the cookie. Omit the
                 attribute and no variant is sent (Chicago funnels are unaffected).

   Two sinks, on every event:
     1) first-party pixel  → GET /t.gif?e=&f=&v=&cb=   (Crate Hackers OS, historical + /api/funnel)
     2) GTM dataLayer push → event:'funnel_<e>' {funnel, variant}  (feeds GA4 in real time;
        add GA4 event tags in GTM-53P4QHG triggered on funnel_view / funnel_cta / funnel_conv,
        with event params `funnel` + `variant` mapped to GA4 custom dimensions).

   `conv` = a lead/opt-in (TY page load), NOT a purchase. The Kartra $27 checkout is
   off-site and can't ping this pixel — reconcile revenue from the Kartra ledger. */
(function (w, d) {
  var TRACK = 'https://os.cratehackers.com/t.gif';
  var s = d.currentScript || (function () { var a = d.getElementsByTagName('script'); return a[a.length - 1]; })();
  var funnel = (s && s.getAttribute('data-funnel')) || 'chicagohackathon';
  var page = (s && s.getAttribute('data-page')) ||
    (/(-ty\b|-ty\/|thank|thanks)/i.test(location.pathname) ? 'ty' : 'optin');

  // Optional A/B variant → sent as `v` (the OS per-variant dimension) + GA4 param.
  function readCookie(name) {
    var parts = d.cookie.split(';');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split('=');
      if (kv[0] && kv[0].trim() === name) return decodeURIComponent((kv[1] || '').trim());
    }
    return '';
  }
  var variantCookie = s && s.getAttribute('data-variant-cookie');
  var VARIANT = '';
  if (variantCookie) {
    var forced = '';
    try { forced = new URLSearchParams(location.search).get('v') || ''; } catch (x) {}
    VARIANT = forced || readCookie(variantCookie) || '';
  }

  w.dataLayer = w.dataLayer || [];

  function track(e) {
    // 1) first-party pixel
    try {
      (new Image()).src = TRACK + '?e=' + encodeURIComponent(e) +
        '&f=' + encodeURIComponent(funnel) +
        (VARIANT ? '&v=' + encodeURIComponent(VARIANT) : '') +
        '&cb=' + Date.now();
    } catch (x) {}
    // 2) GA4 via GTM dataLayer
    try {
      w.dataLayer.push({ event: 'funnel_' + e, funnel: funnel, variant: VARIANT || '(none)' });
    } catch (x) {}
  }

  // Fire a lead exactly once per page load even if invoked twice.
  var fired = false;
  function fireConv() { if (fired) return; fired = true; track('conv'); }

  function initOptin() {
    track('view');
    // Any Kartra pay/opt-in button, or an element flagged with a cta-/checkout class.
    d.addEventListener('click', function (ev) {
      var n = ev.target;
      while (n && n !== d) {
        var c = (n.className && n.className.toString) ? n.className.toString() : '';
        var isPay = n.getAttribute && (n.getAttribute('data-kt-type') === 'pay');
        if (isPay || /js_kt_asset_embed|kartra_optin|cta-|checkout/i.test(c)) {
          track('cta');
          return;
        }
        n = n.parentNode;
      }
    }, true);
  }

  function start() { if (page === 'ty') fireConv(); else initOptin(); }
  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', start);
  else start();
})(window, document);
