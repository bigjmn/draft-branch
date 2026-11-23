// Runs before first paint so the saved theme never flashes. Same storage key as the web app.
try {
  document.documentElement.dataset.theme =
    localStorage.getItem("draftbranch.theme") === "light" ? "light" : "dark";
} catch {}
