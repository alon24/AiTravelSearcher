/* chrome.runtime.sendMessage for the drivers in the app's airline tab: their messages go through the app
   (window.SkyhopAirline, MainActivity.java) to the extension's background.js in the Skyhop tab, and the answer comes
   back as __skyhopBridge.reply. Run before every driver; the second run is a no-op. */
(function () {
  if (window.__skyhopBridge) return;
  var waiting = {}, seq = 0;
  window.__skyhopBridge = {
    reply: function (id, json) {
      var cb = waiting[id];
      delete waiting[id];
      if (cb) cb(JSON.parse(json));
    },
  };
  var c = window.chrome || (window.chrome = {});
  c.runtime = c.runtime || {};
  c.runtime.sendMessage = function (msg, cb) {
    var id = "a" + ++seq;
    waiting[id] = cb || function () {};
    window.SkyhopAirline.send(id, JSON.stringify(msg));
  };
})();
