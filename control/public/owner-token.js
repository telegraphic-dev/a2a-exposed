// A restored page still has the token in the snapshot after the cookie was cleared.
window.addEventListener("pageshow", function (event) {
	if (!event.persisted) return;
	var nodes = document.querySelectorAll(".token");
	for (var i = 0; i < nodes.length; i++) nodes[i].remove();
});
