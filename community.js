// Community features (comments, reactions, favorite) for a book detail page.
// The site itself is static (GitHub Pages) — this is the only live, writable part of it,
// talking to a small API that reuses the same data as the Telegram bot's comments/reactions.
// Only works inside the Telegram Mini App (needs Telegram.WebApp.initData to authenticate);
// outside Telegram it just shows read-only counts with no way to act on them.
(function () {
  var API_BASE = window.COMMUNITY_API_BASE || "";
  var container = document.getElementById("community-widget");
  if (!container || !API_BASE) return;

  var bookId = container.getAttribute("data-book-id");
  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg && tg.initData ? tg.initData : "";
  var canAct = !!initData;

  function api(path, opts) {
    opts = opts || {};
    opts.headers = opts.headers || {};
    if (canAct) opts.headers["Authorization"] = "tma " + initData;
    if (opts.body) opts.headers["Content-Type"] = "application/json";
    return fetch(API_BASE + path, opts).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    });
  }

  function escapeHtml(s) {
    var d = document.createElement("div");
    d.textContent = s == null ? "" : String(s);
    return d.innerHTML;
  }

  var REACTIONS = [
    ["like", "👍"],
    ["dislike", "👎"],
    ["berry", "🍓"],
    ["whale", "🐳"],
  ];

  function render(stats) {
    var reactionsHtml = REACTIONS.map(function (pair) {
      var key = pair[0], emoji = pair[1];
      var count = (stats.reactions && stats.reactions[key]) || 0;
      return (
        '<button class="cw-reaction" data-reaction="' + key + '"' + (canAct ? "" : " disabled") + ">" +
        emoji + " <span>" + count + "</span></button>"
      );
    }).join("");

    container.innerHTML =
      '<div class="cw-row">' +
        reactionsHtml +
        '<button class="cw-fav"' + (canAct ? "" : " disabled") + '>⭐ <span class="cw-fav-label">Sevimli</span></button>' +
      "</div>" +
      '<div class="cw-comments">' +
        "<h2>💬 Izohlar (" + stats.comment_count + " ta)</h2>" +
        '<div class="cw-comment-list">Yuklanmoqda...</div>' +
        (canAct
          ? '<form class="cw-comment-form"><textarea maxlength="2000" placeholder="Fikringizni yozing..." required></textarea><button type="submit">Yuborish</button></form>'
          : '<p class="cw-hint">Izoh qoldirish uchun botning Mini App’ida oching.</p>') +
      "</div>";

    if (canAct) {
      Array.prototype.forEach.call(container.querySelectorAll(".cw-reaction"), function (btn) {
        btn.addEventListener("click", function () {
          api("/api/books/" + bookId + "/reactions", {
            method: "POST",
            body: JSON.stringify({ reaction: btn.getAttribute("data-reaction") }),
          }).then(refreshStats).catch(function () {});
        });
      });
      var favBtn = container.querySelector(".cw-fav");
      favBtn.addEventListener("click", function () {
        api("/api/books/" + bookId + "/favorite", { method: "POST" })
          .then(function (r) {
            favBtn.classList.toggle("cw-fav-on", r.favorited);
          })
          .catch(function () {});
      });
      var form = container.querySelector(".cw-comment-form");
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var ta = form.querySelector("textarea");
        var text = ta.value.trim();
        if (!text) return;
        api("/api/books/" + bookId + "/comments", {
          method: "POST",
          body: JSON.stringify({ text: text }),
        }).then(function () {
          ta.value = "";
          loadComments();
        }).catch(function () {});
      });
    }

    loadComments();
  }

  function loadComments() {
    var list = container.querySelector(".cw-comment-list");
    if (!list) return;
    api("/api/books/" + bookId + "/comments?limit=20").then(function (r) {
      if (!r.comments.length) {
        list.innerHTML = '<p class="cw-hint">Hali izohlar yo’q. Birinchi bo’ling!</p>';
        return;
      }
      list.innerHTML = r.comments.map(function (c) {
        return (
          '<div class="cw-comment"><div class="cw-comment-meta">' + escapeHtml(c.alias) + "</div>" +
          '<div class="cw-comment-text">' + escapeHtml(c.text) + "</div></div>"
        );
      }).join("");
    }).catch(function () {
      list.innerHTML = '<p class="cw-hint">Izohlarni yuklab bo’lmadi.</p>';
    });
  }

  function refreshStats() {
    api("/api/books/" + bookId + "/stats").then(render).catch(function () {
      container.innerHTML = '<p class="cw-hint">Ma’lumotlarni yuklab bo’lmadi.</p>';
    });
  }

  refreshStats();
})();
