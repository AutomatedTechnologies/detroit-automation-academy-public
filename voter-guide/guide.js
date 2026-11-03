/* Voter Guide — renders GUIDE data, quiz, compare tables, checklist. */
(function () {
  "use strict";
  document.documentElement.classList.add("js");
  var data = window.GUIDE;
  var anchorByName = {};

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function partyClass(party) {
    if (/Democratic/.test(party)) return "party-dem";
    if (/Republican/.test(party)) return "party-rep";
    return "party-ind";
  }

  /* ---------- mobile nav ---------- */
  var navToggle = document.getElementById("navToggle");
  var navLinks = document.getElementById("navLinks");
  if (navToggle) {
    navToggle.addEventListener("click", function () {
      var open = navLinks.classList.toggle("open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  /* ---------- race chips ---------- */
  var chipsEl = document.getElementById("raceChips");
  chipsEl.innerHTML = data.races.map(function (r) {
    return '<a class="chip" href="#race-' + r.id + '">' + esc(r.title) + "</a>";
  }).join("") + data.ballotQuestions.slice(0, -1).map(function (q, i) {
    return '<a class="chip chip-measure" href="#bq-' + (i + 1) + '">' + esc(q.short || q.title) + "</a>";
  }).join("");

  /* ---------- candidate card ---------- */
  function cardHTML(c, anchor) {
    var h = '<article class="card reveal" id="' + anchor + '">';
    h += '<div class="card-top"><h3>' + esc(c.name) + '</h3>' +
      '<span class="party-tag ' + partyClass(c.party) + '">' + esc(c.party) + "</span></div>";
    if (c.nomination) h += '<p class="nomination">' + esc(c.nomination) + "</p>";
    if (c.nodata) {
      h += '<p class="nodata">No platform or biographical details found in our research. If you know this candidate\'s positions, check the linked sources — and tell us what we missed.</p>';
    } else {
      if (c.platform && c.platform.length) {
        h += "<h4>Platform</h4><ul>" + c.platform.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul>";
      }
      if (c.record && c.record.length) {
        h += "<h4>Track record</h4><ul>" + c.record.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul>";
      }
      if (c.votes) {
        h += '<div class="votes"><strong>Voting record:</strong> ' + esc(c.votes) + "</div>";
      }
      if (c.endorsements && c.endorsements.length) {
        h += "<h4>Endorsements</h4><ul>" + c.endorsements.map(function (p) { return "<li>" + esc(p) + "</li>"; }).join("") + "</ul>";
      }
    }
    if (c.flag) h += '<p class="cflag"><strong>Flagged:</strong> ' + esc(c.flag) + "</p>";
    if (c.sources && c.sources.length) {
      h += '<div class="sources">' + c.sources.map(function (s) {
        return '<a href="' + esc(s[1]) + '" target="_blank" rel="noopener">' + esc(s[0]) + "</a>";
      }).join("") + "</div>";
    }
    return h + "</article>";
  }

  /* ---------- compare table ---------- */
  function compareHTML(race) {
    if (!race.compare) return "";
    var names = race.compare.issues[0] ? Object.keys(race.compare.issues[0].stances) : [];
    var h = '<div class="compare-toggle"><button class="btn btn-ghost" data-compare="' + race.id + '">Compare candidates side by side</button></div>';
    h += '<div class="compare-wrap" id="compare-' + race.id + '" hidden><table class="compare-table"><thead><tr><th scope="col">Issue</th>' +
      names.map(function (n) { return '<th scope="col">' + esc(n) + "</th>"; }).join("") + "</tr></thead><tbody>";
    race.compare.issues.forEach(function (issue) {
      h += "<tr><th scope=\"row\">" + esc(issue.q) + "</th>";
      names.forEach(function (n) {
        var v = issue.stances[n] || "Not yet researched — see card";
        var cls = (v === "Not yet researched — see card") ? ' class="missing"' : "";
        h += "<td" + cls + ">" + esc(v) + "</td>";
      });
      h += "</tr>";
    });
    return h + "</tbody></table></div>";
  }

  /* ---------- races ---------- */
  var racesEl = document.getElementById("races");
  racesEl.innerHTML = data.races.map(function (race) {
    var h = '<section class="race" id="race-' + race.id + '">';
    h += '<div class="race-head"><h2>' + esc(race.title) + '</h2><span class="vote-for">' + esc(race.voteFor) + "</span></div>";
    h += '<p class="race-context">' + esc(race.context) + "</p>";
    if (race.flag) h += '<div class="race-flag"><strong>Research flag:</strong> ' + esc(race.flag) + "</div>";
    h += compareHTML(race);
    h += '<div class="cards">' + race.candidates.map(function (c, i) {
      var anchor = "cand-" + race.id + "-" + i;
      anchorByName[c.name] = anchor;
      return cardHTML(c, anchor);
    }).join("") + "</div>";
    return h + "</section>";
  }).join("");

  document.querySelectorAll("[data-compare]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var box = document.getElementById("compare-" + btn.getAttribute("data-compare"));
      var show = box.hasAttribute("hidden");
      if (show) { box.removeAttribute("hidden"); btn.textContent = "Hide the comparison"; }
      else { box.setAttribute("hidden", ""); btn.textContent = "Compare candidates side by side"; }
    });
  });

  /* ---------- officials ---------- */
  var offEl = document.getElementById("officialsGrid");
  offEl.innerHTML = data.officials.map(function (o) {
    var h = '<div class="official reveal"><div class="office">' + esc(o.office) + '</div>';
    h += '<div class="who">' + esc(o.name) + "</div>";
    if (o.party) h += '<div class="detail">' + esc(o.party) + "</div>";
    h += '<div class="detail">' + esc(o.note) + "</div>";
    if (o.source) h += '<div class="src"><a href="' + esc(o.source[1]) + '" target="_blank" rel="noopener">' + esc(o.source[0]) + "</a></div>";
    return h + "</div>";
  }).join("");

  /* ---------- ballot questions ---------- */
  var bqEl = document.getElementById("ballotQuestions");
  var bq = data.ballotQuestions;
  var qnote = bq[bq.length - 1];
  bqEl.innerHTML = bq.slice(0, -1).map(function (q, i) {
    var h = '<div class="bq reveal" id="bq-' + (i + 1) + '"><h3>' + esc(q.title) + "</h3><p>" + esc(q.text) + "</p>";
    if (q.support) h += '<h4>Supporters say</h4><p>' + esc(q.support) + "</p>";
    if (q.oppose) h += '<h4>Recorded opposition</h4><p>' + esc(q.oppose) + "</p>";
    if (q.sources) h += '<div class="src">' + q.sources.map(function (s) {
      return '<a href="' + esc(s[1]) + '" target="_blank" rel="noopener">' + esc(s[0]) + "</a>";
    }).join("") + "</div>";
    return h + "</div>";
  }).join("") +
    '<p class="fine" style="margin-top:14px;">' + esc(qnote.note) + ' <a href="' + esc(qnote.source[1]) + '" target="_blank" rel="noopener">' + esc(qnote.source[0]) + "</a></p>";

  /* ---------- quiz ---------- */
  var quizEl = document.getElementById("quizBody");
  var answers = {};
  quizEl.innerHTML = data.quiz.map(function (item, i) {
    return '<div class="quiz-q"><p>' + (i + 1) + ". " + esc(item.q) + "</p>" +
      '<div class="quiz-opts">' + item.options.map(function (opt, j) {
        return '<button type="button" class="quiz-opt" data-q="' + i + '" data-o="' + j + '">' + esc(opt.t) + "</button>";
      }).join("") + "</div></div>";
  }).join("") +
    '<button class="btn btn-primary" id="quizGo">See my matches</button>' +
    '<div class="quiz-result" id="quizResult"></div>';

  quizEl.addEventListener("click", function (e) {
    var b = e.target.closest(".quiz-opt");
    if (b) {
      var q = +b.getAttribute("data-q");
      quizEl.querySelectorAll('.quiz-opt[data-q="' + q + '"]').forEach(function (x) { x.classList.remove("selected"); });
      b.classList.add("selected");
      answers[q] = +b.getAttribute("data-o");
      return;
    }
    if (e.target.id === "quizGo") {
      var scores = {};
      Object.keys(answers).forEach(function (q) {
        data.quiz[q].options[answers[q]].for.forEach(function (name) {
          scores[name] = (scores[name] || 0) + 1;
        });
      });
      var ranked = Object.keys(scores).sort(function (a, b) { return scores[b] - scores[a]; });
      var res = document.getElementById("quizResult");
      if (!ranked.length) {
        res.innerHTML = "<p>Answer at least one question first.</p>";
      } else {
        res.innerHTML = "<h3>Your matches</h3><ol>" + ranked.map(function (n) {
          return "<li><strong>" + esc(n) + "</strong> — matched " + scores[n] + " of your " +
            Object.keys(answers).length + " answers</li>";
        }).join("") + "</ol>" +
          '<p class="qdisclaimer">Based only on positions stated in our sourced research, for the governor and U.S. Senate races. Candidates with no public position on a question simply aren\'t scored on it. This is a starting point for your own reading — not an endorsement.</p>';
      }
      res.classList.add("show");
      if (typeof res.scrollIntoView === "function") res.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  /* ---------- checklist ---------- */
  var KEY = "voter-guide-checklist-v1";
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { saved = {}; }
  var items = data.races.map(function (r) {
    return { id: "race-" + r.id, title: r.title, sub: r.voteFor };
  }).concat(data.ballotQuestions.slice(0, -1).map(function (q, i) {
    return { id: "bq-" + (i + 1), title: "Ballot question: " + q.title, sub: "Yes / No" };
  }));
  var listEl = document.getElementById("checklist");
  function renderChecklist() {
    listEl.innerHTML = items.map(function (it) {
      var done = !!saved[it.id];
      return '<label class="check-item' + (done ? " done" : "") + '">' +
        '<input type="checkbox" data-check="' + it.id + '"' + (done ? " checked" : "") + ">" +
        '<span><span class="check-title">' + esc(it.title) + '</span><br>' +
        '<span class="check-sub">' + esc(it.sub) + "</span></span></label>";
    }).join("");
    var n = items.filter(function (it) { return saved[it.id]; }).length;
    document.getElementById("checkProgress").textContent = n + " of " + items.length + " marked — bring this as a reference, not a ballot.";
  }
  listEl.addEventListener("change", function (e) {
    var c = e.target.closest("[data-check]");
    if (!c) return;
    saved[c.getAttribute("data-check")] = c.checked;
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e2) {}
    renderChecklist();
  });
  renderChecklist();
  document.getElementById("printBtn").addEventListener("click", function () { window.print(); });

  /* ---------- reveal on scroll (with fail-safe) ---------- */
  function revealAll() {
    document.querySelectorAll(".reveal:not(.visible)").forEach(function (el) { el.classList.add("visible"); });
  }
  if ("IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("visible"); io.unobserve(en.target); }
      });
    }, { threshold: 0.08 });
    document.querySelectorAll(".reveal").forEach(function (el) { io.observe(el); });
    /* Fail-safe: if the observer never fires (stale cache, backgrounded tab,
       content blocker), don't leave content invisible — reveal everything. */
    setTimeout(revealAll, 2500);
  } else {
    revealAll();
  }

  /* ---------- election countdown ---------- */
  var el = document.getElementById("countdown");
  if (el) {
    var target = new Date("2026-11-03T07:00:00-05:00").getTime();
    var days = Math.max(0, Math.ceil((target - Date.now()) / 86400000));
    el.textContent = days;
  }
  var upd = document.getElementById("updated");
  if (upd) upd.textContent = data.updated;

  /* ---------- alignment explorer ---------- */
  (function initAlignment() {
    var picker = document.getElementById("alignPicker");
    var out = document.getElementById("alignResults");
    if (!picker || !out || !window.ALIGN || !window.ALIGN_ISSUES) return;
    var A = window.ALIGN;
    var issueLabel = {};
    window.ALIGN_ISSUES.forEach(function (it) { issueLabel[it.key] = it.label; });

    data.races.forEach(function (race) {
      var inRace = race.candidates.filter(function (c) { return A[c.name]; });
      if (!inRace.length) return;
      var g = document.createElement("optgroup");
      g.label = race.title;
      inRace.forEach(function (c) {
        var o = document.createElement("option");
        o.value = c.name;
        o.textContent = c.name + " — " + c.party;
        g.appendChild(o);
      });
      picker.appendChild(g);
    });

    function renderAlignment(name) {
      var me = A[name];
      if (!me) {
        out.innerHTML = '<p class="align-empty">Select a candidate to map their on-the-record issues against the rest of the ballot.</p>';
        return;
      }
      var keys = Object.keys(me.issues);
      var scored = Object.keys(A).filter(function (n) { return n !== name; }).map(function (n) {
        return { name: n, shared: keys.filter(function (k) { return A[n].issues[k]; }) };
      }).filter(function (s) { return s.shared.length; })
        .sort(function (a, b) { return b.shared.length - a.shared.length; }).slice(0, 5);

      var h = '<div class="align-head"><h3>' + esc(name) + '</h3>' +
        '<span class="party-tag ' + partyClass(me.party) + '">' + esc(me.party) + "</span>" +
        '<span class="align-race">' + esc(me.race) + "</span></div>";
      h += '<p class="align-note">' + keys.length + " issue" + (keys.length === 1 ? "" : "s") + " on the record.</p>";
      if (scored.length) {
        h += '<div class="align-top"><span class="align-top-label">Most shared issues:</span> ' +
          scored.map(function (s) {
            return '<button type="button" class="align-chip" data-pick="' + esc(s.name) + '">' +
              esc(s.name) + " <b>" + s.shared.length + "</b></button>";
          }).join("") + "</div>";
      }
      keys.forEach(function (k) {
        h += '<div class="align-issue"><h4>' + esc(issueLabel[k] || k) + "</h4>";
        h += me.issues[k].map(function (s) { return '<p class="align-mine">' + esc(s) + "</p>"; }).join("");
        var others = Object.keys(A).filter(function (n) { return n !== name && A[n].issues[k]; });
        if (others.length) {
          h += '<p class="align-others-label">Also addressed by:</p><ul class="align-others">';
          others.forEach(function (n) {
            var o = A[n];
            h += '<li><div class="align-other-head"><strong>' + esc(n) + "</strong> " +
              '<span class="party-tag ' + partyClass(o.party) + '">' + esc(o.party) + "</span>";
            if (anchorByName[n]) h += ' <a class="align-link" href="#' + anchorByName[n] + '">View full card</a>';
            h += "</div>";
            h += o.issues[k].map(function (s) { return '<p class="align-quote">' + esc(s) + "</p>"; }).join("");
            h += "</li>";
          });
          h += "</ul>";
        }
        h += "</div>";
      });
      out.innerHTML = h;
      out.querySelectorAll("[data-pick]").forEach(function (b) {
        b.addEventListener("click", function () {
          picker.value = b.getAttribute("data-pick");
          renderAlignment(picker.value);
          out.scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
      });
    }
    picker.addEventListener("change", function () { renderAlignment(picker.value); });
  })();
})();
