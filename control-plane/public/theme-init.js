// Apply before CSS/React to prevent a wrong-theme first paint. No user data is read.
(() => {
  let mode = "auto";
  try {
    const saved = localStorage.getItem("btc-theme");
    if (saved === "light" || saved === "dark") mode = saved;
  } catch {}
  const dark =
    mode === "dark" ||
    (mode === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#0a0a0a" : "#f4f4f5");
})();
