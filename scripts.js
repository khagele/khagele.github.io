function setRange(range) {
  document.querySelectorAll("button").forEach(b => b.classList.remove("active"));
  document.getElementById(range).classList.add("active");

  document.querySelectorAll("iframe[data-base]").forEach(frame => {
    frame.src = frame.dataset.base
      .replace("{FROM}", range === "6h" ? "now-6h" : range === "24h" ? "now-24h" : "now-7d");
  });
}
