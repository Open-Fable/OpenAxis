var params = new URLSearchParams(window.location.search);
var active = params.get("active") || "chat";

document.querySelectorAll(".item").forEach(function (btn) {
  if (btn.dataset.slot === active) {
    btn.classList.add("active");
  }
  btn.addEventListener("click", function () {
    window.openaxis.navPopupSelect(btn.dataset.slot);
  });
});
