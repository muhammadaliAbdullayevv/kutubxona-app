// Community features (comments, replies, likes, reactions, favorite) for a book detail page.
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
  // Comments this browser has liked THIS session — the API only tells us the total like
  // count, not whether the current user already liked a given comment, so a fresh page load
  // always starts unfilled; clicking still toggles correctly either way.
  var likedThisSession = {};

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

  function commentHtml(c, isReply) {
    var liked = !!likedThisSession[c.id];
    return (
      '<div class="cw-comment' + (isReply ? " cw-reply" : "") + '" data-id="' + c.id + '">' +
        '<div class="cw-comment-meta">' + escapeHtml(c.alias) + "</div>" +
        '<div class="cw-comment-text">' + escapeHtml(c.text) + "</div>" +
        '<div class="cw-comment-actions">' +
          '<button class="cw-like' + (liked ? " cw-like-on" : "") + '" data-id="' + c.id + '"' + (canAct ? "" : " disabled") + ">" +
            "👍 <span>" + (c.like_count || 0) + "</span></button>" +
          (!isReply && canAct
            ? '<button class="cw-reply-btn" data-id="' + c.id + '">Javob berish</button>'
            : "") +
          (!isReply && c.reply_count
            ? '<button class="cw-show-replies" data-id="' + c.id + '">' + c.reply_count + " ta javobni ko’rish</button>"
            : "") +
        "</div>" +
        (!isReply ? '<div class="cw-replies" data-parent="' + c.id + '"></div>' : "") +
      "</div>"
    );
  }

  function wireCommentActions(scope) {
    Array.prototype.forEach.call(scope.querySelectorAll(".cw-like"), function (btn) {
      if (btn.disabled) return;
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        api("/api/comments/" + id + "/like", { method: "POST" }).then(function (r) {
          likedThisSession[id] = r.liked;
          btn.classList.toggle("cw-like-on", r.liked);
          btn.querySelector("span").textContent = r.like_count;
        }).catch(function () {});
      });
    });
    Array.prototype.forEach.call(scope.querySelectorAll(".cw-reply-btn"), function (btn) {
      btn.addEventListener("click", function () {
        var parentId = btn.getAttribute("data-id");
        var comment = btn.closest(".cw-comment");
        if (comment.querySelector(".cw-reply-form")) return; // already open
        var formEl = document.createElement("form");
        formEl.className = "cw-reply-form";
        formEl.innerHTML = '<textarea maxlength="2000" placeholder="Javobingiz..." required></textarea><button type="submit">Yuborish</button>';
        comment.querySelector(".cw-replies").insertAdjacentElement("afterbegin", formEl);
        formEl.addEventListener("submit", function (e) {
          e.preventDefault();
          var text = formEl.querySelector("textarea").value.trim();
          if (!text) return;
          api("/api/books/" + bookId + "/comments", {
            method: "POST",
            body: JSON.stringify({ text: text, parent_comment_id: parentId }),
          }).then(function () {
            formEl.remove();
            loadReplies(parentId, true);
          }).catch(function () {});
        });
      });
    });
    Array.prototype.forEach.call(scope.querySelectorAll(".cw-show-replies"), function (btn) {
      btn.addEventListener("click", function () {
        loadReplies(btn.getAttribute("data-id"), false);
        btn.remove();
      });
    });
  }

  function loadReplies(parentId, append) {
    var repliesEl = container.querySelector('.cw-replies[data-parent="' + parentId + '"]');
    if (!repliesEl) return;
    api("/api/comments/" + parentId + "/replies").then(function (r) {
      var html = r.replies.map(function (c) { return commentHtml(c, true); }).join("");
      if (append) {
        repliesEl.insertAdjacentHTML("beforeend", html);
      } else {
        repliesEl.innerHTML = html;
      }
      wireCommentActions(repliesEl);
    }).catch(function () {});
  }

  function loadComments() {
    var list = container.querySelector(".cw-comment-list");
    if (!list) return;
    api("/api/books/" + bookId + "/comments?limit=20").then(function (r) {
      if (!r.comments.length) {
        list.innerHTML = '<p class="cw-hint">Hali izohlar yo’q. Birinchi bo’ling!</p>';
        return;
      }
      list.innerHTML = r.comments.map(function (c) { return commentHtml(c, false); }).join("");
      wireCommentActions(list);
    }).catch(function () {
      list.innerHTML = '<p class="cw-hint">Izohlarni yuklab bo’lmadi.</p>';
    });
  }

  function refreshStats() {
    api("/api/books/" + bookId + "/stats").then(render).catch(function () {
      container.innerHTML = '<p class="cw-hint">Ma’lumotlarni yuklab bo’lmadi.</p>';
    });
  }

  function diag(msg) {
    // TEMPORARY diagnostic — shows a native Telegram popup instead of just logging, since the
    // real device's console isn't reachable. Safe to remove once the root cause is confirmed.
    if (tg && tg.showAlert) tg.showAlert(msg);
    else window.alert(msg);
  }

  function wireDeliverButton() {
    // The "📖 Botda ochish" control is a plain <button> in the static HTML now — NOT an
    // <a href="t.me/...">. Telegram's Mini App WebView can intercept a t.me link at the
    // native level, based on the raw page source, before this script ever runs — so removing
    // an href via JS (the previous approach) was too late; the link had to never exist in the
    // HTML at all. The deep link is only ever constructed here, in memory, as a fallback.
    var ctaBtn = document.getElementById("cta-open-bot");
    if (!ctaBtn) return;
    var fallbackHref = "https://t.me/pdf_audio_kitoblar_bot?start=b_" + bookId;
    var originalLabel = ctaBtn.textContent;
    if (!canAct) {
      // No initData (opened outside Telegram, or Telegram didn't provide it for this launch
      // method) — can't call the authenticated deliver API, so this is just a normal deep-link
      // button in that context.
      ctaBtn.addEventListener("click", function () {
        diag("DEBUG: canAct=false — tg exists=" + (!!tg) + ", initData empty. Falling back to deep link.");
        window.location.href = fallbackHref;
      });
      return;
    }
    ctaBtn.addEventListener("click", function () {
      ctaBtn.textContent = "Yuborilmoqda...";
      ctaBtn.classList.add("cw-disabled");
      api("/api/books/" + bookId + "/deliver", { method: "POST" })
        .then(function () {
          ctaBtn.textContent = "✅ Yuborildi — botdagi chatingizni tekshiring";
          ctaBtn.classList.remove("cw-disabled");
        })
        .catch(function (err) {
          // Couldn't deliver in-app (not cached, bot not started yet, etc.) — only now does
          // a real t.me navigation happen, so only a genuine failure ever leaves the Mini App.
          diag("DEBUG: deliver call failed — " + (err && err.message ? err.message : String(err)));
          ctaBtn.textContent = originalLabel;
          ctaBtn.classList.remove("cw-disabled");
          window.location.href = fallbackHref;
        });
    });
  }

  refreshStats();
  wireDeliverButton();
})();
