function a2aTurnstileButtons(enabled) {
	var form = document.querySelector("form[action='/app/sign-in']");
	if (!form) return;
	var buttons = form.querySelectorAll("button[name='provider']");
	for (var i = 0; i < buttons.length; i++) buttons[i].disabled = !enabled;
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

// Reset after this submit has copied the token, so a blocked redirect can be tried again.
window.addEventListener("submit", function (event) {
	var form = event.target;
	if (!form || !form.getAttribute || form.getAttribute("action") !== "/app/sign-in") return;
	setTimeout(a2aTurnstileReset, 0);
});
