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
