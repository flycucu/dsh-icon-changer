/**
 * dsh-icon-changer — 客户端半边（浏览器）。
 *
 * 宿主半边（lib/index.js）已经提供了 HTTP API；这里只做一件事：往设置页
 * （slot `settings.section`）注册一张卡片，让主人点按钮换图标，不必手输 URL。
 *
 * 浏览器半边的加载协议：window.__ModuleLoader__.load({ id, factory })，
 * factory 里用 require("react") 拿共享的 React，最后返回 module.exports。
 * 需要用到 ctx 上的服务时，服务名必须写进导出的 inject 数组。
 */
window.__ModuleLoader__.load({
  id: "dsh-icon-changer",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");
    var h = react.createElement;
    var useState = react.useState;
    var useEffect = react.useEffect;

    var API = "/api/icon-changer";
    var STYLE_ID = "dsh-icon-changer-style";
    var TARGETS = [
      { id: "exe", label: "应用图标（exe / 任务栏）" },
      { id: "tray", label: "托盘图标" },
      { id: "startmenu", label: "开始菜单" }
    ];

    // ── HTTP：同源请求，浏览器自动带上 Web 鉴权凭证 ──────────────────────────
    function readError(res, fallback) {
      return res
        .json()
        .then(function (data) {
          return (data && (data.message || data.error)) || fallback;
        })
        .catch(function () {
          return fallback;
        });
    }

    function requestJson(path, options) {
      return fetch(API + path, options).then(function (res) {
        if (!res.ok) {
          return readError(res, "HTTP " + res.status).then(function (message) {
            throw new Error(message);
          });
        }
        return res.json();
      });
    }

    function post(path, payload) {
      return requestJson(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {})
      });
    }

    function getStatus() {
      return requestJson("/status");
    }

    function getIcons() {
      return requestJson("/icons");
    }

    function previewUrl(id) {
      return API + "/preview/" + encodeURIComponent(id);
    }

    // 把宿主给的 appliedId 翻成人看的文案：卡片要停在"应用当前穿着的图标"上。
    function currentIconLabel(list, appliedId) {
      if (!appliedId) return "未知（还没通过本插件换过图标）";
      var hit = (list || []).filter(function (item) {
        return item.id === appliedId;
      })[0];
      return (hit ? hit.label || hit.name : appliedId) + "（" + appliedId + "）";
    }

    // FileReader 的 dataURL 前缀在末尾带一个逗号，而宿主只接受裸 base64。
    function readAsBase64(file) {
      return new Promise(function (resolve, reject) {
        var reader = new FileReader();
        reader.onerror = function () {
          reject(new Error("读取文件失败"));
        };
        reader.onload = function () {
          var text = String(reader.result || "");
          var comma = text.indexOf(",");
          if (comma < 0) {
            reject(new Error("读取文件失败"));
            return;
          }
          resolve(text.slice(comma + 1));
        };
        reader.readAsDataURL(file);
      });
    }

    // ── 样式：只注入一次 ────────────────────────────────────────────────────
    function injectStyles() {
      if (document.getElementById(STYLE_ID)) return;
      var style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = [
        ".dic-root{display:flex;flex-direction:column;gap:12px;font-size:13px;line-height:1.5}",
        ".dic-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}",
        ".dic-muted{opacity:.65}",
        ".dic-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:10px}",
        ".dic-card{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 8px;border:1px solid rgba(127,127,127,.3);border-radius:10px;background:rgba(127,127,127,.06);cursor:pointer;transition:border-color .15s,background .15s}",
        ".dic-card:hover{border-color:rgba(127,127,127,.6)}",
        ".dic-card.is-selected{border-color:#4c8dff;background:rgba(76,141,255,.12)}",
        ".dic-card.is-current{border-color:rgba(80,200,120,.8)}",
        ".dic-card img{width:48px;height:48px;object-fit:contain}",
        ".dic-name{font-size:11px;max-width:88px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
        ".dic-del{position:absolute;top:2px;right:4px;width:20px;height:20px;line-height:1;padding:0;border-radius:50%;border:1px solid rgba(127,127,127,.45);background:rgba(127,127,127,.12);color:inherit;cursor:pointer;font-size:14px;opacity:0;transition:opacity .15s}",
        ".dic-card:hover .dic-del{opacity:.75}",
        ".dic-del:hover{opacity:1;border-color:rgba(255,90,90,.7);background:rgba(255,90,90,.18)}",
        ".dic-btn{padding:6px 14px;border-radius:8px;border:1px solid rgba(127,127,127,.4);background:rgba(127,127,127,.1);color:inherit;cursor:pointer;font-size:13px}",
        ".dic-btn:hover:not(:disabled){background:rgba(127,127,127,.2)}",
        ".dic-btn:disabled{opacity:.45;cursor:not-allowed}",
        ".dic-btn.is-primary{border-color:rgba(230,60,60,.85);background:rgba(215,45,45,.9);color:#fff}",
        ".dic-btn.is-primary:hover:not(:disabled){background:rgba(235,65,65,1)}",
        ".dic-msg{padding:8px 10px;border-radius:8px;font-size:12px}",
        ".dic-msg.is-error{border:1px solid rgba(255,90,90,.5);background:rgba(255,90,90,.12)}",
        ".dic-msg.is-ok{border:1px solid rgba(80,200,120,.5);background:rgba(80,200,120,.12)}",
        ".dic-msg.is-warn{border:1px solid rgba(255,190,80,.5);background:rgba(255,190,80,.12)}",
        ".dic-hint{font-size:12px;opacity:.6}",
        ".dic-targets{display:flex;flex-direction:column;gap:6px;padding:10px 12px;border:1px solid rgba(127,127,127,.25);border-radius:10px}",
        ".dic-target{display:flex;align-items:center;gap:8px}",
        ".dic-target input{cursor:pointer}",
        ".dic-target .dic-path{font-size:11px;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:46ch}",
        ".dic-badge{font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid rgba(127,127,127,.4);opacity:.8}",
        ".dic-badge.is-ok{border-color:rgba(80,200,120,.6);color:rgba(110,220,150,1)}",
        ".dic-badge-empty{border-color:transparent;background:transparent}",
        ".dic-code{font-family:ui-monospace,Consolas,monospace;font-size:11px;word-break:break-all;opacity:.85}"
      ].join("");
      document.head.appendChild(style);
    }

    // ── 设置卡片 ────────────────────────────────────────────────────────────
    function Section() {
      var [status, setStatus] = useState(null);
      var [icons, setIcons] = useState([]);
      var [selected, setSelected] = useState("");
      var [targets, setTargets] = useState(["exe", "tray", "startmenu"]);
      var [busy, setBusy] = useState("");
      var [error, setError] = useState("");
      var [notice, setNotice] = useState("");

      function refresh() {
        getStatus()
          .then(function (data) {
            setStatus(data);
            setError("");
            // 默认停在"应用当前真正穿着的图标"上（其次才是排队中的那个），
            // 用户手动点过别的图标后不再覆盖他的选择。
            var current =
              (data && data.appliedId) ||
              (data && data.pending && data.pending.icon) ||
              "";
            if (current) {
              setSelected(function (prev) {
                return prev || current;
              });
            }
          })
          .catch(function (err) {
            setError(err.message || String(err));
          });
        getIcons()
          .then(function (data) {
            var list = (data && data.icons) || [];
            setIcons(list);
            setSelected(function (prev) {
              return prev || (list.length ? list[0].id : "");
            });
          })
          .catch(function () {
            /* 图标列表失败不覆盖状态错误 */
          });
      }

      useEffect(function () {
        injectStyles();
        refresh();
      }, []);

      var pending = status && status.pending;
      var pendingKey = pending ? pending.queuedAt || "pending" : "";
      // 应用退出后这个页面会消失；轮询只是给"没退出成功"的情况兜底。
      useEffect(
        function () {
          if (!pendingKey) return undefined;
          var timer = window.setInterval(refresh, 3000);
          return function () {
            window.clearInterval(timer);
          };
        },
        [pendingKey]
      );

      function setBusyThen(label, task) {
        setBusy(label);
        setError("");
        setNotice("");
        task()
          .then(function (data) {
            if (data && data.queued) {
              setNotice(data.message || "任务已就绪");
            } else {
              setNotice("操作已提交");
            }
            return refresh();
          })
          .catch(function (err) {
            setError(err.message || String(err));
          })
          .then(function () {
            setBusy("");
          });
      }

      function toggleTarget(id) {
        setTargets(function (prev) {
          if (prev.indexOf(id) >= 0) {
            var next = prev.filter(function (x) {
              return x !== id;
            });
            return next.length ? next : prev;
          }
          return prev.concat([id]);
        });
      }

      function onApply() {
        if (!selected) return;
        setBusyThen("apply", function () {
          return post("/apply", { icon: selected, restart: true, targets: targets });
        });
      }


      function onCancelPending() {
        setBusyThen("cancel", function () {
          return post("/clear", {});
        });
      }

      function onDeleteIcon(icon) {
        if (!icon || icon.kind !== "user") return;
        if (!window.confirm("删除上传的图标 " + (icon.label || icon.name) + " ？此操作不可撤销。")) return;
        setBusyThen("delete", function () {
          return requestJson("/icon/" + encodeURIComponent(icon.id), { method: "DELETE" }).then(function (data) {
            setSelected(function (prev) {
              return prev === icon.id ? "" : prev;
            });
            return data;
          });
        });
      }

      function onPickFile(event) {
        var input = event.target;
        var file = input.files && input.files[0];
        input.value = "";
        if (!file) return;
        if (!/\.ico$/i.test(file.name)) {
          setError("只接受 .ico 文件");
          return;
        }
        setBusyThen("upload", function () {
          return readAsBase64(file).then(function (base64) {
            return post("/upload", { name: file.name, b64: base64 }).then(function (data) {
              if (data && data.icon && data.icon.id) setSelected(data.icon.id);
              if (data && data.warning) setNotice(data.warning);
              return data;
            });
          });
        });
      }

      if (!status) {
        return h(
          "div",
          { className: "dic-root" },
          h("div", { className: "dic-muted" }, error ? "读取状态失败：" + error : "读取中…")
        );
      }

      var exe = status.exe || {};
      var lastResult = status.lastResult;
      var targetInfo = status.targets || {};
      // A queued job the worker never finished must not lock the UI forever: the
      // host marks anything older than 20s as stale, and stale means "retry it".
      var pendingStale = Boolean(status.pendingStale);
      var blocked = busy !== "" || (Boolean(pending) && !pendingStale);

      return h(
        "div",
        { className: "dic-root" },
        h(
          "div",
          { className: "dic-hint" },
          "Windows 上图标有三个独立位置（exe 资源、托盘文件、开始菜单快捷方式），本卡片一次把选中的都换掉。exe 必须在应用退出后才能改写。"
        ),

        !status.isDesktopApp &&
          h("div", { className: "dic-msg is-warn" }, "当前不是桌面端（没有可改写的 exe），只能改快捷方式图标。"),

        h(
          "div",
          { className: "dic-muted" },
          "exe：" + (exe.path || "未知") + (exe.size ? "（" + Math.round(exe.size / 1048576) + " MB）" : "")
        ),

        h(
          "div",
          { className: "dic-row" },
          h(
            "span",
            { className: "dic-badge is-ok" },
            "当前图标"
          ),
          h(
            "span",
            { className: "dic-hint" },
            currentIconLabel(icons, status.appliedId)
          )
        ),

        pending &&
          h(
            "div",
            { className: "dic-msg " + (pendingStale ? "is-error" : "is-warn") },
              h("button", { className: "dic-btn", onClick: onCancelPending }, "取消排队"),
            (pendingStale ? "上次任务没有跑完：" : "已就绪：") +
              pending.op +
              " " +
              (pending.icon || "") +
              " → " +
              ((pending.targets || []).join(", ") || "全部") +
              (pendingStale
                ? "。超过 20 秒仍未落地，说明后台 worker 没起来；点「取消排队」后重新提交即可。"
                : pending.restart === false
                  ? "。托盘与开始菜单已立即写入；关闭应用后自动完成 exe 替换。"
                  : "。托盘与开始菜单已立即写入；应用即将自动重启，重启过程中完成 exe 替换。")
          ),

        lastResult &&
          h(
            "div",
            { className: "dic-msg " + (lastResult.ok ? "is-ok" : "is-error") },
            "上次结果：" + (lastResult.ok ? "成功" : "失败") + " — " + (lastResult.message || "")
          ),

        h("div", { className: "dic-grid" }, icons.map(function (icon) {
          return h(
            "div",
            {
              key: icon.id,
              className:
                "dic-card" +
                (selected === icon.id ? " is-selected" : "") +
                (status.appliedId === icon.id ? " is-current" : ""),
              onClick: function () {
                setSelected(icon.id);
              },
              title: icon.id
            },
            h("img", { src: previewUrl(icon.id), alt: icon.name, loading: "lazy" }),
            // 只有"未使用的外部上传图标"能删：内置/原版从来不给叉，正在用的那个也不给
            // （宿主那边同样会拒绝，避免旧界面绕过按钮）。
            icon.kind === "user" && status.appliedId !== icon.id
              ? h(
                  "button",
                  {
                    className: "dic-del",
                    title: "删除这个图标",
                    onClick: function (event) {
                      event.stopPropagation();
                      onDeleteIcon(icon);
                    }
                  },
                  "\u00d7"
                )
              : null,
            h("span", { className: "dic-name" }, icon.label || icon.name),
            // 类型词条与"当前使用"角标各占一行：上传的图标没有词条，但用等高的空位占住，
            // 否则它那张卡片会比别人矮、整行看着就变形了。
            h(
              "span",
              { className: "dic-hint" },
              icon.kind === "builtin" ? "内置" : icon.kind === "original" ? "原版" : "\u00a0"
            ),
            status.appliedId === icon.id
              ? h("span", { className: "dic-badge is-ok" }, "当前使用")
              : h("span", { className: "dic-badge dic-badge-empty" }, "\u00a0")
          );
        })),

        h(
          "div",
          { className: "dic-targets" },
          h("div", { className: "dic-muted" }, "要更换的位置："),
          TARGETS.map(function (target) {
            var info = targetInfo[target.id] || {};
            return h(
              "label",
              { className: "dic-target", key: target.id },
              h("input", {
                type: "checkbox",
                checked: targets.indexOf(target.id) >= 0,
                onChange: function () {
                  toggleTarget(target.id);
                }
              }),
              h("span", null, target.label),
              info.backup
                ? h("span", { className: "dic-badge is-ok" }, "已备份")
                : h("span", { className: "dic-badge" }, "未备份"),
              h("span", { className: "dic-path", title: info.path || "" }, info.path || "")
            );
          })
        ),

        h(
          "div",
          { className: "dic-row" },
          h("button", { className: "dic-btn is-primary", onClick: onApply, disabled: blocked || !selected },
            busy === "apply" ? "提交中…" : "立刻重启并更换"
          ),
          h(
            "label",
            { className: "dic-btn" },
            busy === "upload" ? "上传中…" : "上传 .ico",
            h("input", {
              type: "file",
              accept: ".ico,image/x-icon",
              style: { display: "none" },
              onChange: onPickFile,
              disabled: blocked
            })
          )
        ),

        error && h("div", { className: "dic-msg is-error" }, error),
        notice && h("div", { className: "dic-msg is-ok" }, notice),

        h(
          "div",
          { className: "dic-row" },
          // 手动拉取入口：卡片只在挂载时刷新、以及"有排队任务"时每 3 秒轮询，
          // 外部改动（例如往 icons/ 里手工放图标、或本插件之外改了 state）靠它立刻拉进来。
          h(
            "button",
            {
              className: "dic-btn",
              onClick: refresh,
              title: "重新读取宿主状态与图标列表（托盘/开始菜单的写入与 exe 替换都由后台自动完成，无需手动触发）"
            },
            "刷新状态"
          )
        )
      );
    }

    // 浏览器半边访问 ctx.<服务名> 之前，服务名必须声明在这里。
    var inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register(
          {
            name: "settings.section",
            id: "icon-changer",
            order: 130,
            label: function () {
              return "应用图标";
            }
          },
          Section
        );
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
