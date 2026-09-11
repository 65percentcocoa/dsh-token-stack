window.__ModuleLoader__.load({
	id: "dsh-token-stack",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var h = React.createElement;

		/** Poll the Host route and return [stats, error]. */
		function useStats() {
			var state = React.useState(null);
			var stats = state[0];
			var setStats = state[1];
			var errState = React.useState(null);
			var error = errState[0];
			var setError = errState[1];
			React.useEffect(function () {
				var alive = true;
				function tick() {
					fetch("/token-stack/stats", { cache: "no-store" })
						.then(function (r) { return r.json(); })
						.then(function (j) { if (alive) { setStats(j); setError(null); } })
						.catch(function (e) { if (alive) setError(String(e)); });
				}
				tick();
				var id = setInterval(tick, 5000);
				return function () { alive = false; clearInterval(id); };
			}, []);
			return [stats, error];
		}

		function row(label, value) {
			return h("div", {
				key: label,
				style: { display: "flex", justifyContent: "space-between", gap: "10px", whiteSpace: "nowrap" },
			},
				h("span", { style: { opacity: 0.6 } }, label),
				h("span", { style: { fontVariantNumeric: "tabular-nums" } }, value));
		}

		/** The floating stats card (collapsible). */
		function TokenStackCard() {
			var pair = useStats();
			var stats = pair[0];
			var error = pair[1];
			var openState = React.useState(true);
			var open = openState[0];
			var setOpen = openState[1];
			var f = (stats && stats.filter) || {};
			var m = (stats && stats.memory) || {};
			var tools = f.byTool ? Object.keys(f.byTool).length : 0;
			var sessions = stats && stats.bySession ? Object.keys(stats.bySession).length : 0;
			var ab = !!(stats && typeof stats.mode === "string" && stats.mode.indexOf("AB") === 0);
			return h("div", {
				style: {
					position: "fixed", top: "10px", right: "10px", zIndex: 60, width: "228px",
					padding: "9px 11px", borderRadius: "12px",
					background: "var(--dsw-alias-bg-module-platform, rgba(26,26,30,0.94))",
					color: "var(--dsw-alias-label-primary, #e9e9ec)",
					border: "1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.14))",
					boxShadow: "0 8px 24px rgba(0,0,0,0.30)", backdropFilter: "blur(8px)",
					font: "11px/1.55 ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
					userSelect: "none",
				},
			},
				h("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: open ? "7px" : "0" } },
					h("strong", { style: { fontSize: "11px", letterSpacing: "0.04em", textTransform: "uppercase", opacity: 0.85 } },
						"token-stack" + (ab ? " · A/B off" : "")),
					h("button", {
						type: "button",
						"aria-label": open ? "collapse" : "expand",
						onClick: function () { setOpen(!open); },
						style: { background: "transparent", border: "none", color: "inherit", cursor: "pointer", opacity: 0.65, fontSize: "11px", padding: "0 2px", lineHeight: 1 },
					}, open ? "−" : "+")),
				open ? h("div", { style: { display: "flex", flexDirection: "column", gap: "1px" } },
					row("filter saved tok", String(f.tokensSaved == null ? "—" : f.tokensSaved)),
					row("filter calls", String(f.calls == null ? "—" : f.calls)),
					row("mem injected tok", String(m.tokensInjected == null ? "—" : m.tokensInjected)),
					row("mem entries", String(m.entriesAdded == null ? "—" : m.entriesAdded)),
					row("sessions", String(sessions)),
					row("tools", String(tools)),
					h("div", { style: { marginTop: "5px", fontSize: "10px", opacity: 0.45, lineHeight: 1.4 } },
						"filter saved = precise; memory = cost; terse not measured"),
					error ? h("div", { style: { marginTop: "4px", fontSize: "10px", color: "#ff8f8f" } }, "stats fetch failed: " + error.slice(0, 40)) : null)
					: null);
		}

		/** Client plugin: register the card into the frame-wide overlay slot. */
		var inject = ["slots"];
		function apply(ctx) {
			ctx.slots.inject("shell.overlay", function () {
				return ctx.slots.register({ name: "shell.overlay", id: "token-stack", order: 100 }, TokenStackCard);
			});
		}

		exports.TokenStackCard = TokenStackCard;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
