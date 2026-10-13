// Copy buttons, live address previews, and the empty-state opener.
// The forms still work when this file does not run.
(function () {
	function text(value, fallback) {
		var cleaned = String(value || "").trim().toLowerCase();
		return cleaned || fallback;
	}

	document.addEventListener("click", function (event) {
		var target = event.target;
		if (!target || !target.closest) return;
		var copy = target.closest("[data-copy]");
		if (copy && navigator.clipboard && navigator.clipboard.writeText) {
			var value = copy.getAttribute("data-copy") || "";
			if (!value) return;
			var previous = copy.textContent;
			navigator.clipboard.writeText(value).then(function () {
				copy.textContent = "Copied";
				window.setTimeout(function () { copy.textContent = previous; }, 1500);
			}).catch(function () {});
		}
		var open = target.closest("[data-open-new]");
		if (!open) return;
		var panel = document.getElementById("new-agent");
		if (panel) panel.open = true;
		var field = document.getElementById(open.getAttribute("data-open-new") || "");
		if (field && field.focus) field.focus();
	});

	var hosted = document.querySelector("[data-hosted-name]");
	var hostedLabel = document.querySelector("[data-hosted-label]");
	if (hosted && hostedLabel) {
		var syncHosted = function () { hostedLabel.textContent = text(hosted.value, "name"); };
		hosted.addEventListener("input", syncHosted);
		syncHosted();
	}

	var cloudflare = document.querySelector("[data-cf-name]");
	var cloudflareLabel = document.querySelector("[data-cf-label]");
	if (cloudflare && cloudflareLabel) {
		var syncCloudflare = function () { cloudflareLabel.textContent = text(cloudflare.value, "name"); };
		cloudflare.addEventListener("input", syncCloudflare);
		syncCloudflare();
	}
})();
