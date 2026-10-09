/**
 * MoltBridge Lightweight Analytics
 * Tracks page views, scroll depth, time on page, and CTA clicks.
 * Events stored server-side via /analytics/event endpoint.
 */
(function() {
  var sid = sessionStorage.getItem('mb_sid');
  if (!sid) {
    sid = Math.random().toString(36).substring(2) + Date.now().toString(36);
    sessionStorage.setItem('mb_sid', sid);
  }

  var page = location.pathname.replace(/\/$/, '') || '/';
  var startTime = Date.now();
  var maxScroll = 0;
  var sent = {};

  function track(event, data) {
    var key = event + JSON.stringify(data || {});
    if (sent[key]) return;
    sent[key] = true;

    var payload = {
      session_id: sid,
      event: event,
      page: page,
      timestamp: new Date().toISOString(),
      data: data || {}
    };

    if (navigator.sendBeacon) {
      navigator.sendBeacon('/analytics/event', JSON.stringify(payload));
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/analytics/event', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(payload));
    }
  }

  // Page view
  track('page_view', { referrer: document.referrer });

  // Scroll depth (report at 25%, 50%, 75%, 100%)
  var thresholds = [25, 50, 75, 100];
  var reported = {};

  function checkScroll() {
    var scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    var docHeight = document.documentElement.scrollHeight - window.innerHeight;
    if (docHeight <= 0) return;

    var pct = Math.round((scrollTop / docHeight) * 100);
    if (pct > maxScroll) maxScroll = pct;

    for (var i = 0; i < thresholds.length; i++) {
      if (pct >= thresholds[i] && !reported[thresholds[i]]) {
        reported[thresholds[i]] = true;
        track('scroll_depth', { depth: thresholds[i] });
      }
    }
  }

  window.addEventListener('scroll', checkScroll, { passive: true });

  // Time on page (report at 10s, 30s, 60s, 120s)
  var timeThresholds = [10, 30, 60, 120];
  var timeReported = {};

  setInterval(function() {
    var elapsed = Math.round((Date.now() - startTime) / 1000);
    for (var i = 0; i < timeThresholds.length; i++) {
      if (elapsed >= timeThresholds[i] && !timeReported[timeThresholds[i]]) {
        timeReported[timeThresholds[i]] = true;
        track('time_on_page', { seconds: timeThresholds[i] });
      }
    }
  }, 5000);

  // CTA clicks
  document.addEventListener('click', function(e) {
    var el = e.target.closest('a[href], button');
    if (!el) return;

    var href = el.getAttribute('href') || '';
    var text = (el.textContent || '').trim().substring(0, 50);
    var classes = el.className || '';

    if (classes.indexOf('nav-cta') >= 0 || classes.indexOf('btn') >= 0) {
      track('cta_click', { text: text, href: href, element: el.tagName });
    } else if (href && href.indexOf('/') === 0 && href !== page) {
      track('internal_nav', { to: href, text: text });
    }
  });

  // Page exit
  window.addEventListener('beforeunload', function() {
    var elapsed = Math.round((Date.now() - startTime) / 1000);
    track('page_exit', { time_spent: elapsed, max_scroll: maxScroll });
  });
})();
