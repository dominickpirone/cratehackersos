/* Chicago hackathon funnels — first-party pixel → Crate Hackers OS.

   Drop ONE tag on each lander page (after GTM is fine):
     <script src="/shared/ch-funnels.js" data-funnel="chicagohackathon" data-page="optin"></script>

   data-funnel : which funnel this page belongs to. Use the SAME id on a funnel's
                 opt-in AND thank-you page so they aggregate together:
                   chicagohackathon  → /chicagohackathon (opt-in) + /chicagohackathon-ty (TY)
                   chicago           → /chicago (in-person opt-in) + /chicago-ty (TY)
   data-page   : "optin" → fires `view` on load + `cta` on any Kartra checkout/opt-in click
                 "ty"    → fires `conv` on load (= one confirmed LEAD / opt-in)
                 (omitted → auto-detected from the URL: *-ty / thank-you ⇒ ty)

   The OS reads these at /api/funnel?funnel=<id>. Revenue is reconciled separately
   from the Kartra sales ledger (Kartra's off-site checkout can't ping this pixel),
   so on the Chicago funnels `conv` deliberately means a lead, not a purchase. */
(function (w, d) {
  var TRACK = 'https://cratehackersos-qmmv.onrender.com/t.gif';
  var s = d.currentScript || (function () { var a = d.getElementsByTagName('script'); return a[a.length - 1]; })();
  var funnel = (s && s.getAttribute('data-funnel')) || 'chicagohackathon';
  var page = (s && s.getAttribute('data-page')) ||
    (/(-ty\b|-ty\/|thank|thanks)/i.test(location.pathname) ? 'ty' : 'optin');

  function track(e, tier) {
    try {
      (new Image()).src = TRACK + '?e=' + encodeURIComponent(e) +
        '&f=' + encodeURIComponent(funnel) +
        (tier ? '&tier=' + encodeURIComponent(tier) : '') +
        '&cb=' + Date.now();
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
