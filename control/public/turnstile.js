function a2aTurnstileForms() {
	var actions = ["/app/sign-in", "/app/feedback"];
	var forms = [];
	for (var i = 0; i < actions.length; i++) {
		var form = document.querySelector("form[action='" + actions[i] + "']");
		if (form) forms.push(form);
	}
	return forms;
}

function a2aTurnstileButtons(enabled) {
	var forms = a2aTurnstileForms();
	for (var f = 0; f < forms.length; f++) {
		var buttons = forms[f].querySelectorAll("button[name='provider'], button.action");
		for (var i = 0; i < buttons.length; i++) {
			buttons[i].disabled = !enabled;
			if (enabled) buttons[i].removeAttribute("aria-disabled");
			else buttons[i].setAttribute("aria-disabled", "true");
		}
	}
}

function a2aTurnstileReady() {
	a2aTurnstileButtons(true);
}

function a2aTurnstileWait() {
	a2aTurnstileButtons(false);
}

function a2aTurnstileReset() {
	a2aTurnstileButtons(false);
	if (window.turnstile && typeof window.turnstile.reset === "function") window.turnstile.reset();
}

// A restored page still holds the token the last submit already spent.
window.addEventListener("pageshow", function (event) {
	if (event.persisted) a2aTurnstileReset();
});

// A click before the check finishes does not submit. The button stays disabled until then.
window.addEventListener("submit", function (event) {
	var form = event.target;
	if (!form || !form.querySelector) return;
	if (!form.querySelector(".cf-turnstile")) return;
	var token = form.querySelector("input[name='cf-turnstile-response']");
	if (token && String(token.value || "").trim()) return;
	event.preventDefault();
	event.stopPropagation();
	a2aTurnstileButtons(false);
}, true);

// Reset after this submit has copied the token, so a blocked redirect can be tried again.
window.addEventListener("submit", function (event) {
	var form = event.target;
	if (!form || !form.getAttribute) return;
	var action = form.getAttribute("action");
	if (action !== "/app/sign-in" && action !== "/app/feedback") return;
	setTimeout(a2aTurnstileReset, 0);
});
