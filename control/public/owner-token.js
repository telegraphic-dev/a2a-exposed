// The token is the input value. A copy of that field is the token alone, with no surrounding whitespace.
function tokenValue(root) {
	var node = root.querySelector(".token-value");
	if (!node || typeof node.value !== "string") return "";
	return node.value.replace(/^\s+|\s+$/g, "");
}

function bindToken(root) {
	var button = root.querySelector(".copy-token");
	if (!button) return;
	button.hidden = false;
	button.addEventListener("click", function () {
		var text = tokenValue(root);
		var field = root.querySelector(".token-value");
		if (!text) return;
		var mark = function () { button.textContent = "Copied"; };
		var select = function () {
			if (!field || !field.focus || !field.select) return;
			field.focus();
			field.select();
		};
		var fallback = function () {
			select();
			try { if (document.execCommand("copy")) mark(); } catch (e) { /* the field stays selected */ }
		};
		if (navigator.clipboard && navigator.clipboard.writeText) {
			navigator.clipboard.writeText(text).then(mark, fallback);
			return;
		}
		fallback();
	});
}

var tokens = document.querySelectorAll(".token");
for (var i = 0; i < tokens.length; i++) bindToken(tokens[i]);

document.addEventListener("copy", function (event) {
	var root = document.querySelector(".token");
	if (!root || !event.clipboardData) return;
	var field = root.querySelector(".token-value");
	if (!field) return;
	var sel = document.getSelection();
	if (!sel || !sel.rangeCount) return;
	var node = sel.anchorNode;
	var el = node && node.nodeType === 1 ? node : node && node.parentNode;
	if (!el || (el !== field && !field.contains(el))) return;
	var text = tokenValue(root);
	if (!text) return;
	event.preventDefault();
	event.clipboardData.setData("text/plain", text);
});

// A restored page still has the token in the snapshot after the cookie was cleared.
window.addEventListener("pageshow", function (event) {
	if (!event.persisted) return;
	var nodes = document.querySelectorAll(".token");
	for (var i = 0; i < nodes.length; i++) nodes[i].remove();
});
