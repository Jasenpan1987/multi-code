// The language toggle and the copy buttons. The language is set before first paint
// by the inline script in index.html; this only switches and remembers it.

document.querySelector(".lang-toggle").addEventListener("click", () => {
  const next = document.documentElement.getAttribute("data-lang") === "zh" ? "en" : "zh";
  document.documentElement.setAttribute("data-lang", next);
  document.documentElement.setAttribute("lang", next === "zh" ? "zh-CN" : "en");
  try {
    localStorage.setItem("lang", next);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
});

// The agent prompt is fetched at load, so a click can copy it at once. Safari only
// lets a page write the clipboard inside the click, so there the copy hands the
// clipboard a promise instead of awaiting the fetch first.
const agentPrompt = fetch("agent-prompt.txt").then((res) =>
  res.ok ? res.text() : Promise.reject(new Error(`agent-prompt.txt: ${res.status}`))
);
agentPrompt.catch(() => {});

function flash(button, en, zh) {
  const before = button.innerHTML;
  button.innerHTML = `<span lang="en">${en}</span><span lang="zh">${zh}</span>`;
  setTimeout(() => (button.innerHTML = before), 2000);
}

for (const button of document.querySelectorAll(".agent-copy-btn")) {
  button.addEventListener("click", async () => {
    try {
      if (window.ClipboardItem && navigator.clipboard.write) {
        const blob = agentPrompt.then((text) => new Blob([text], { type: "text/plain" }));
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      } else {
        await navigator.clipboard.writeText(await agentPrompt);
      }
      flash(button, "Copied. Paste it into your agent", "已复制，粘贴给你的 agent");
    } catch {
      flash(button, "Couldn't copy. Use the link below", "复制失败，用下面的链接");
    }
  });
}

for (const button of document.querySelectorAll(".copy")) {
  button.addEventListener("click", async () => {
    const text = button.parentElement.querySelector("code").textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = document.documentElement.getAttribute("data-lang") === "zh" ? "已复制" : "Copied";
    } catch {
      button.textContent = "⌘C";
    }
    setTimeout(() => (button.textContent = "Copy"), 1500);
  });
}
