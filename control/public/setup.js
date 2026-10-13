// Updates a Cloudflare setup in place. Without this script the forms still post.
(function () {
	function root() {
		return document.querySelector("[data-setup-root]");
	}

	function apply(data) {
		if (!data || typeof data !== "object") return;
		if (typeof data.redirect === "string" && data.redirect) {
			window.location.href = data.redirect;
			return;
		}
		var node = root();
		if (!node || typeof data.html !== "string") return;
		var wrap = document.createElement("div");
		wrap.innerHTML = data.html;
		var next = wrap.querySelector("[data-setup-root]") || wrap.firstElementChild;
		if (!next) return;
		node.replaceWith(next);
		arm();
		var auto = next.querySelector("form[data-auto='1']");
		if (auto && typeof auto.requestSubmit === "function") auto.requestSubmit();
	}

	var timer = 0;
	function arm() {
		if (timer) window.clearTimeout(timer);
		var node = root();
		var seconds = node ? Number(node.getAttribute("data-refresh-seconds") || "0") : 0;
		if (seconds > 0) timer = window.setTimeout(pull, seconds * 1000);
	}

	function pull() {
		window.fetch(window.location.pathname + window.location.search, {
			headers: { accept: "application/json", "x-setup-partial": "1" },
			credentials: "same-origin",
		}).then(function (response) { return response.json(); }).then(apply).catch(function () {});
	}

	document.addEventListener("submit", function (event) {
		var form = event.target;
		if (!form || !form.getAttribute || form.getAttribute("data-setup") !== "1") return;
		if (!window.fetch || !window.FormData) return;
		event.preventDefault();
		window.fetch(form.getAttribute("action") || window.location.pathname, {
			method: "POST",
			body: new FormData(form),
			headers: { accept: "application/json", "x-setup-partial": "1" },
			credentials: "same-origin",
		}).then(function (response) { return response.json(); }).then(apply).catch(function () {
			form.submit();
		});
	});

	arm();
})();
