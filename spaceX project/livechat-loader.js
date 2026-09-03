(function () {
  // Prevent duplicate script execution
  if (window.__livechat_loaded) return;
  window.__livechat_loaded = true;

  // Small loader that injects the live chat widget DOM and initializes it.

  var widgetHTML = `
  <div id="chat-overlay" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.72);z-index:2147483640;transition:opacity .22s ease;opacity:0"></div>
  <div id="live-widget" style="position:fixed;right:18px;bottom:18px;z-index:2147483647;font-family:Inter,system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;pointer-events:auto">
    <button id="widget-btn" title="Open Live Support" style="width:56px;height:56px;border-radius:9999px;background:#4f46e5;color:#fff;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 30px rgba(2,6,23,0.2);border:0;cursor:grab;transition:transform .18s ease,box-shadow .18s ease;touch-action:none">
      <svg xmlns="http://www.w3.org/2000/svg" style="width:28px;height:28px;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V7a2 2 0 012-2h14a2 2 0 012 2v5a2 2 0 01-2 2h-3l-4 4z"/></svg>
      <span id="badge" style="position:absolute;top:-6px;right:-6px;background:#ef4444;color:#fff;font-size:11px;padding:2px 6px;border-radius:999px;display:none">1</span>
    </button>

    <div id="chat-window" style="display:none;transition:all .22s ease;transform:translateY(8px);opacity:0;background:#fff;border-radius:12px;box-shadow:0 18px 50px rgba(2,6,23,0.3);width:400px;max-width:92vw;max-height:560px;overflow:hidden;display:flex;flex-direction:column;margin-top:12px;z-index:2147483650;">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid #eee">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="font-weight:600">Live Support</div>
          <div style="display:flex;align-items:center;gap:6px;font-size:13px;color:#16a34a"><div style="width:8px;height:8px;border-radius:999px;background:#86efac"></div><div>Online</div></div>
        </div>
        <div style="display:flex;gap:8px;align-items:center"><button id="chat-expand" title="Expand" style="background:none;border:0;font-size:16px;cursor:pointer;color:#374151">⤢</button><button id="chat-close" style="background:none;border:0;font-size:18px;cursor:pointer;color:#374151">×</button></div>
      </div>
      <div id="messages" style="flex:1;overflow:auto;padding:12px;background:#f8fafc;color:#111827"></div>
      <div style="padding:10px;border-top:1px solid #eee">
        <div style="display:flex;gap:8px">
          <input id="msg-input" placeholder="Type a message..." style="flex:1;padding:10px;border-radius:8px;border:1px solid #e6e6e6;outline:none;color:#000" />
          <button id="send-btn" style="background:#4f46e5;color:#fff;padding:10px 14px;border-radius:8px;border:0;cursor:pointer">Send</button>
        </div>
        <div id="status-line" style="font-size:12px;color:#6b7280;margin-top:8px;height:16px"></div>
      </div>
    </div>
  </div>`;

  // append DOM once body is available
  console.log("livechat-loader: loaded");
  function appendContainer() {
    if (document.getElementById("livechat-injected")) return;
    var container = document.createElement("div");
    container.id = "livechat-injected";
    container.innerHTML = widgetHTML;
    document.body.appendChild(container);
  }
  if (document.body) appendContainer();
  else document.addEventListener("DOMContentLoaded", appendContainer);

  // load socket.io client
  function loadScript(src, cb) {
    var s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = cb;
    s.onerror = function () {
      console.warn("Failed to load", src);
      cb && cb();
    };
    document.head.appendChild(s);
  }

  // After socket.io is ready, initialize the widget
  function initWidget() {
    try {
      console.log("livechat-loader: initWidget");
      // minimal polyfill for escapeHtml
      function escapeHtml(value) {
        return String(value || "").replace(
          /[&<>'"]/g,
          (c) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[c],
        );
      }
      // elements
      var widgetBtn = document.getElementById("widget-btn");
      var chatWindow = document.getElementById("chat-window");
      var chatClose = document.getElementById("chat-close");
      var messagesEl = document.getElementById("messages");
      var msgInput = document.getElementById("msg-input");
      // ensure input text is visible (black)
      try {
        if (msgInput) msgInput.style.color = "#000";
      } catch (e) {}
      var sendBtn = document.getElementById("send-btn");
      var badge = document.getElementById("badge");
      var statusLine = document.getElementById("status-line");

      var API_BASE = "http://localhost:4000";
      var SOCKET_URL = "http://localhost:4000";
      var token = localStorage.getItem("authToken");

      var socket = null;
      var currentSession = null;
      var openState = false;
      var unread = 0;

      function formatTime(dt) {
        var d = new Date(dt);
        return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      }

      function appendMessage(msg, opts) {
        opts = opts || {};
        var own = !!opts.own;
        var senderRole = msg.senderRole || (own ? "USER" : "ADMIN");
        var isClient = senderRole === "USER";
        var optimistic = !!opts.optimistic;
        var tempId = opts.tempId || null;
        var msgId = msg.id || null;
        var wrapper = document.createElement("div");
        wrapper.style.display = "flex";
        // Client/User messages on LEFT, Admin messages on RIGHT
        wrapper.style.justifyContent = isClient ? "flex-start" : "flex-end";
        wrapper.style.marginBottom = "12px";

        var bubble = document.createElement("div");
        bubble.style.maxWidth = "78%";
        bubble.style.padding = "10px 14px";
        bubble.style.borderRadius = "14px";
        bubble.style.wordWrap = "break-word";
        bubble.style.position = "relative";

        // Client: light gray, Admin: indigo with shadow
        if (isClient) {
          bubble.style.background = "#f1f5f9";
          bubble.style.color = "#1e293b";
          bubble.style.borderBottomLeftRadius = "2px";
        } else {
          bubble.style.background = "#4f46e5";
          bubble.style.color = "#ffffff";
          bubble.style.borderBottomRightRadius = "2px";
          bubble.style.boxShadow = "0 4px 12px rgba(79, 70, 229, 0.25)";
        }

        bubble.className = "msg-arrive";
        bubble.innerHTML =
          '<div style="font-size:10px;margin-bottom:4px;opacity:0.8;font-weight:600">' +
          (isClient ? "You" : "Support") +
          "</div>" +
          escapeHtml(msg.content) +
          '<div style="font-size:10px;margin-top:6px;text-align:right;opacity:0.7">' +
          formatTime(msg.createdAt || Date.now()) +
          (own && isClient
            ? ' <span class="msg-status">' +
              (optimistic ? "..." : "✓✓") +
              "</span>"
            : "") +
          "</div>";

        wrapper.appendChild(bubble);
        if (optimistic && tempId) wrapper.dataset.tempId = tempId;
        if (msgId) wrapper.dataset.msgId = msgId;
        messagesEl.appendChild(wrapper);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return wrapper;
      }

      function updateOptimisticStatus(tempId) {
        var wrappers = Array.from(messagesEl.children);
        for (var i = wrappers.length - 1; i >= 0; i--) {
          var w = wrappers[i];
          if (w.dataset && w.dataset.tempId == tempId) {
            var st = w.querySelector(".msg-status");
            if (st) st.textContent = "Sent ✓✓";
            w.removeAttribute("data-temp-id");
            break;
          }
        }
      }

      function showToast(text) {
        try {
          var t = document.createElement("div");
          t.style.position = "fixed";
          t.style.right = "18px";
          t.style.bottom = "92px";
          t.style.background = "#111827";
          t.style.color = "#fff";
          t.style.padding = "8px 12px";
          t.style.borderRadius = "8px";
          t.style.boxShadow = "0 6px 20px rgba(2,6,23,0.2)";
          t.textContent = text;
          document.body.appendChild(t);
          setTimeout(function () {
            t.style.opacity = 0;
            setTimeout(() => t.remove(), 400);
          }, 3000);
        } catch (e) {}
      }

      function openChat() {
        var overlay = document.getElementById("chat-overlay");
        if (overlay) {
          overlay.style.display = "block";
          setTimeout(() => (overlay.style.opacity = "1"), 20);
        }
        chatWindow.style.display = "flex";
        setTimeout(function () {
          chatWindow.style.transform = "translateY(0)";
          chatWindow.style.opacity = "1";
        }, 20);
        openState = true;
        unread = 0;
        badge.style.display = "none";
        ensureSession().then(function () {
          if (currentSession && socket)
            socket.emit("joinSession", currentSession.id);
          loadMessages();
        });
      }
      function closeChat() {
        var overlay = document.getElementById("chat-overlay");
        if (overlay) {
          overlay.style.opacity = "0";
          setTimeout(() => (overlay.style.display = "none"), 220);
        }
        chatWindow.style.transform = "translateY(8px)";
        chatWindow.style.opacity = "0";
        openState = false;
        setTimeout(function () {
          if (!openState) chatWindow.style.display = "none";
        }, 240);
      }

      // pointer drag/click handling + expand
      var liveWidgetEl = document.getElementById("live-widget");
      widgetBtn.style.touchAction = "none";
      widgetBtn.style.cursor = "grab";
      var isPointerDown = false,
        isDragging = false,
        dragStartX = 0,
        dragStartY = 0,
        widgetStartLeft = 0,
        widgetStartTop = 0;
      widgetBtn.addEventListener("pointerdown", function (e) {
        isPointerDown = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        var rect = liveWidgetEl.getBoundingClientRect();
        widgetStartLeft = rect.left;
        widgetStartTop = rect.top;
        try {
          widgetBtn.setPointerCapture(e.pointerId);
        } catch (err) {}
      });
      window.addEventListener(
        "pointermove",
        function (e) {
          if (!isPointerDown) return;
          var dx = e.clientX - dragStartX,
            dy = e.clientY - dragStartY;
          if (!isDragging && Math.hypot(dx, dy) > 6) {
            isDragging = true;
            widgetBtn.style.cursor = "grabbing";
          }
          if (isDragging) {
            liveWidgetEl.style.left = widgetStartLeft + dx + "px";
            liveWidgetEl.style.top = widgetStartTop + dy + "px";
            liveWidgetEl.style.right = "auto";
            liveWidgetEl.style.bottom = "auto";
          }
        },
        { passive: true },
      );
      window.addEventListener("pointerup", function (e) {
        if (!isPointerDown) return;
        isPointerDown = false;
        try {
          widgetBtn.releasePointerCapture(e.pointerId);
        } catch (err) {}
        if (isDragging) {
          isDragging = false;
          widgetBtn.style.cursor = "grab";
          // snap to nearest corner
          var rect = liveWidgetEl.getBoundingClientRect();
          var cx = rect.left + rect.width / 2,
            cy = rect.top + rect.height / 2;
          var w = window.innerWidth,
            h = window.innerHeight;
          var corners = [
            { name: "tl", x: 0, y: 0 },
            { name: "tr", x: w, y: 0 },
            { name: "bl", x: 0, y: h },
            { name: "br", x: w, y: h },
          ];
          var best = corners[0],
            bestD = Infinity;
          corners.forEach(function (c) {
            var dx = c.x - cx,
              dy = c.y - cy,
              d = Math.hypot(dx, dy);
            if (d < bestD) {
              bestD = d;
              best = c;
            }
          });
          if (best.name === "tl") {
            liveWidgetEl.style.left = "18px";
            liveWidgetEl.style.top = "18px";
            liveWidgetEl.style.right = "auto";
            liveWidgetEl.style.bottom = "auto";
          } else if (best.name === "tr") {
            liveWidgetEl.style.right = "18px";
            liveWidgetEl.style.top = "18px";
            liveWidgetEl.style.left = "auto";
            liveWidgetEl.style.bottom = "auto";
          } else if (best.name === "bl") {
            liveWidgetEl.style.left = "18px";
            liveWidgetEl.style.bottom = "18px";
            liveWidgetEl.style.right = "auto";
            liveWidgetEl.style.top = "auto";
          } else {
            liveWidgetEl.style.right = "18px";
            liveWidgetEl.style.bottom = "18px";
            liveWidgetEl.style.left = "auto";
            liveWidgetEl.style.top = "auto";
          }
        } else {
          // click — toggle chat
          if (!openState) openChat();
          else closeChat();
        }
      });

      // expand button
      var chatExpand = document.getElementById("chat-expand");
      var expanded = false;
      if (chatExpand) {
        chatExpand.addEventListener("click", function (e) {
          e.stopPropagation();
          expanded = !expanded;
          if (expanded) {
            chatWindow.style.width = "min(92vw,680px)";
            chatWindow.style.maxHeight = "80vh";
          } else {
            chatWindow.style.width = "400px";
            chatWindow.style.maxHeight = "560px";
          }
        });
      }

      chatClose.addEventListener("click", function () {
        closeChat();
      });

      // socket
      function connectSocket() {
        try {
          if (typeof io === "undefined") {
            console.warn("socket.io client not available");
            return;
          }
          socket = io(SOCKET_URL, { auth: { token } });
          socket.on("connect", function () {
            console.log("socket connected");
          });
          socket.on("support:message", function (payload) {
            var msg = payload.message;
            // Check if message already exists in DOM (optimistic or previous sync)
            var wrappers = Array.from(messagesEl.children);
            var existingWrapper = null;
            for (var i = wrappers.length - 1; i >= 0; i--) {
              var w = wrappers[i];
              if (
                w.textContent.includes(msg.content) &&
                (w.dataset.msgId === msg.id || w.dataset.tempId)
              ) {
                existingWrapper = w;
                break;
              }
            }

            if (existingWrapper && existingWrapper.dataset.tempId) {
              // Update optimistic status
              var st = existingWrapper.querySelector(".msg-status");
              if (st) st.textContent = "Sent ✓✓";
              existingWrapper.dataset.msgId = msg.id;
              existingWrapper.removeAttribute("data-temp-id");
              return;
            }
            if (existingWrapper) return;

            if (msg.senderRole === "ADMIN") {
              if (!openState) {
                unread++;
                badge.style.display = "block";
                badge.textContent = unread;
                showToast("New message from Support");
              }
              appendMessage(msg, { own: false });
            } else {
              // Message from user (likely another tab)
              appendMessage(msg, { own: true });
            }
          });
          socket.on("support:session:new", function (p) {
            console.log("new session", p);
          });
          socket.on("support:session:closed", function (p) {
            showToast("Support session closed");
          });

          // Listen for server-side unread counts (persisted in server memory)
          socket.on("support:unread", function (payload) {
            try {
              var sId = payload.sessionId;
              var val = Number(payload.unread) || 0;
              if (val > 0 && !openState) {
                badge.style.display = "block";
                badge.textContent = val;
                showToast("New message from Support");
                unread = val;
              } else if (val === 0) {
                unread = 0;
                badge.style.display = "none";
              }
            } catch (e) {}
          });

          // Listen for balance updates from admin takeover
          socket.on("balance:update", function (payload) {
            try {
              var type =
                payload.type === "deposit" ? "added to" : "removed from";
              var msg =
                "Funds " + type + " your account: " + money(payload.amount);
              showToast(msg);
              // Optionally refresh page or update UI if balance is displayed
              if (
                window.location.pathname.includes("home.html") ||
                window.location.pathname.includes("investments.html")
              ) {
                setTimeout(function () {
                  window.location.reload();
                }, 2000);
              }
            } catch (e) {}
          });

          // Listen for KYC status updates from server
          socket.on("kyc:status", function (payload) {
            try {
              var st =
                payload && payload.status
                  ? String(payload.status).toLowerCase()
                  : null;
              if (!st) return;
              if (st === "approved" || st === "APPROVED" || st === "approved") {
                // remove pending banner and kyc mask if present
                var b = document.getElementById("kyc-pending-banner");
                if (b) b.remove();
                var mask = document.getElementById("kyc-mask");
                if (mask) mask.className = "kyc-mask";
                showToast("KYC approved by Support");
              } else if (st === "pending" || st === "PENDING") {
                // ensure pending banner exists
                var b2 = document.getElementById("kyc-pending-banner");
                if (!b2) {
                  var kb = document.createElement("div");
                  kb.id = "kyc-pending-banner";
                  kb.textContent = "KYC: Pending";
                  kb.style.position = "fixed";
                  kb.style.right = "16px";
                  kb.style.top = "80px";
                  kb.style.background = "#fff7ed";
                  kb.style.border = "1px solid #f59e0b";
                  kb.style.color = "#92400e";
                  kb.style.padding = "8px 10px";
                  kb.style.borderRadius = "8px";
                  kb.style.zIndex = 60;
                  kb.style.fontWeight = 600;
                  document.body.appendChild(kb);
                }
              } else if (st === "rejected" || st === "REJECTED") {
                showToast("KYC document rejected by admin"); // user can be directed to re-upload
              }
            } catch (e) {}
          });
        } catch (e) {
          console.warn("socket connect failed", e);
        }
      }

      // load messages via API
      async function loadMessages() {
        if (!currentSession) return;
        try {
          var res = await fetch(
            API_BASE +
              "/api/support/sessions/" +
              currentSession.id +
              "/messages",
            { headers: { Authorization: "Bearer " + token } },
          );
          if (!res.ok) throw new Error("Failed");
          var payload = await res.json();
          messagesEl.innerHTML = "";
          (payload.messages || []).forEach(function (m) {
            appendMessage(m, { own: m.senderRole === "USER" });
          });
        } catch (err) {
          console.warn(err);
        }
      }

      async function ensureSession() {
        if (currentSession) return currentSession;
        try {
          var res = await fetch(API_BASE + "/api/support/sessions", {
            headers: { Authorization: "Bearer " + token },
          });
          if (res.ok) {
            var payload = await res.json();
            var sessions = payload.sessions || [];
            if (sessions.length > 0 && sessions[0].status === "OPEN") {
              currentSession = sessions[0];
              return currentSession;
            }
          }
        } catch (e) {}
        try {
          var r = await fetch(API_BASE + "/api/support/initiate", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: "Bearer " + token,
            },
            body: JSON.stringify({ context: "web:widget" }),
          });
          if (r.ok) {
            var p = await r.json();
            currentSession = p.session;
            return currentSession;
          }
        } catch (err) {
          console.warn("init session err", err);
        }
      }

      async function sendMessage() {
        var text = msgInput.value.trim();
        if (!text) return;
        if (!currentSession) await ensureSession();
        var tempId = "t" + Date.now();
        var wrapper = appendMessage(
          { content: text, createdAt: Date.now() },
          { own: true, optimistic: true, tempId: tempId },
        );
        wrapper.dataset.tempId = tempId;
        msgInput.value = "";
        statusLine.textContent = "";
        if (socket && socket.connected) {
          socket.emit(
            "support:send",
            { sessionId: currentSession.id, content: text },
            function (ack) {
              if (ack && ack.ok) {
                updateOptimisticStatus(tempId);
              } else {
                var st = wrapper.querySelector(".msg-status");
                if (st) st.textContent = "Failed";
              }
            },
          );
        } else {
          try {
            var r = await fetch(API_BASE + "/api/support/messages", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + token,
              },
              body: JSON.stringify({
                sessionId: currentSession.id,
                content: text,
              }),
            });
            if (r.ok) {
              var payload = await r.json();
              updateOptimisticStatus(tempId);
            } else {
              var st = wrapper.querySelector(".msg-status");
              if (st) st.textContent = "Failed";
            }
          } catch (err) {
            var st = wrapper.querySelector(".msg-status");
            if (st) st.textContent = "Failed";
          }
        }
      }

      sendBtn.addEventListener("click", sendMessage);
      msgInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendMessage();
        }
      });

      // expose openLiveChat for pages to call
      window.openLiveChat = function () {
        if (!openState) openChat();
        else {
          /* already open */
        }
      };
      // if a page requested the chat before the loader was ready, open now
      if (window.__openLiveChatRequested) {
        try {
          window.openLiveChat();
        } catch (e) {}
        window.__openLiveChatRequested = false;
      }

      // follow-scroll behavior: move widget up slightly when user scrolls to make it more visible
      try {
        var liveWidgetEl = document.getElementById("live-widget");
        var lastScroll = 0;
        function onScrollFollow() {
          try {
            var y = window.scrollY || document.documentElement.scrollTop || 0;
            // when user scrolls down beyond 120px, raise widget a bit so it's not overlapped by footers
            if (y > 120) {
              liveWidgetEl.style.bottom = "80px";
              // subtle pop to draw attention
              widgetBtn.style.transform = "translateY(-6px) scale(1.02)";
              widgetBtn.style.boxShadow = "0 18px 46px rgba(2,6,23,0.28)";
            } else {
              liveWidgetEl.style.bottom = "18px";
              widgetBtn.style.transform = "";
              widgetBtn.style.boxShadow = "";
            }
            lastScroll = y;
          } catch (e) {}
        }
        window.addEventListener("scroll", onScrollFollow, { passive: true });
        // initial call
        onScrollFollow();
      } catch (e) {}

      // connect
      connectSocket();
    } catch (e) {
      console.warn("initWidget error", e);
    }
  }

  // Load socket.io client then init
  if (typeof io === "undefined") {
    loadScript("https://cdn.socket.io/4.6.1/socket.io.min.js", function () {
      initWidget();
    });
  } else {
    initWidget();
  }
})();
