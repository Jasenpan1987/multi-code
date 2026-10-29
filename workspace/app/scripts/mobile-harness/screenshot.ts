// Screenshots of the phone app as an iPhone 15 Pro shows it from the Home Screen:
// WebKit, 393 × 852 at 3x, touch, in dark and light. Pairs from the running
// harness's URL first, as a scanned QR would, then opens the route.
//   pnpm harness:shot --control <control url> [--scenario <name>] [--route '#/s/multi-code']
//                     [--scheme dark|light|both] [--tap <selector>]... [--wait <ms>] [--out <path>]
//                     [--focus <selector> [--keyboard <pt>] [--pan <pt>]]
// `--scenario` starts that scenario over, paused, before each shot, so every shot
// starts from the same state whatever an earlier tap did (POST /resume on the
// control channel starts its clock again).
// `--focus` gives a field the focus after the taps; `--keyboard` then plays the
// iPhone's keyboard coming up that tall (336 is an iPhone 15 Pro's), as the page
// sees it: visualViewport shrinks by it, and with `--pan` iOS has panned the page
// up by that much, as it does to show a field at the bottom. The shot shows what
// the phone's screen would, a grey box standing in for the keyboard.

import { devices, webkit } from "playwright";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const control = option("control") ?? process.env.HARNESS_CONTROL;
if (!control) {
  console.error("usage: pnpm harness:shot --control <control url printed by pnpm harness> [--route '#/'] …");
  process.exit(2);
}
const scenario = option("scenario");
const route = option("route");
const scheme = option("scheme") ?? "both";
const schemes = scheme === "both" ? (["dark", "light"] as const) : ([scheme] as ("dark" | "light")[]);
const taps = args.flatMap((a, i) => (a === "--tap" && args[i + 1] ? [args[i + 1]] : []));
const wait = Number(option("wait") ?? 1000);
const focus = option("focus");
const keyboard = Number(option("keyboard") ?? 0);
const pan = Number(option("pan") ?? 0);
const out = (option("out") ?? `/tmp/mc-harness-shot${scenario ? `-${scenario}` : ""}`).replace(/\.png$/, "");

async function startScenario() {
  if (!scenario) return;
  const res = await fetch(`${control}/scenario/${scenario}?live=0`, { method: "POST" });
  if (!res.ok) throw new Error(`scenario ${scenario}: ${await res.text()}`);
}
const { url } = (await (await fetch(`${control}/pair`)).json()) as { url: string };

const browser = await webkit.launch();
try {
  for (const colorScheme of schemes) {
    await startScenario();
    const context = await browser.newContext({
      ...devices["iPhone 15 Pro"],
      // The whole screen: a Home Screen app has no Safari toolbars.
      viewport: { width: 393, height: 852 },
      colorScheme,
    });
    const page = await context.newPage();
    page.on("pageerror", (err) => console.error(`[${colorScheme}] page error: ${err.message}`));
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`[${colorScheme}] console: ${msg.text()}`);
    });
    await page.goto(url);
    if (route) await page.evaluate((hash) => (location.hash = hash), route);
    for (const selector of taps) await page.locator(selector).first().tap();
    if (focus) await page.locator(focus).first().focus();
    if (keyboard > 0) await page.evaluate(playKeyboard, { height: keyboard, pan, dark: colorScheme === "dark" });
    await page.waitForTimeout(wait);
    const file = schemes.length > 1 ? `${out}-${colorScheme}.png` : `${out}.png`;
    await page.screenshot({ path: file });
    console.log(file);
    await context.close();
  }
} finally {
  await browser.close();
}

// In the page: the keyboard is up, `height` tall, and iOS has panned the page by `pan`.
function playKeyboard({ height, pan, dark }: { height: number; pan: number; dark: boolean }) {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const full = window.innerHeight;
  Object.defineProperty(viewport, "height", { configurable: true, get: () => full - height });
  Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => pan });
  // What the pan does to the picture: the page's y = pan is at the top of the screen.
  if (pan) document.documentElement.style.transform = `translateY(${-pan}px)`;
  const box = document.createElement("div");
  box.textContent = `keyboard (${height} pt${pan ? `, page panned ${pan} pt` : ""})`;
  Object.assign(box.style, {
    position: "absolute",
    left: "0",
    right: "0",
    top: `${pan + full - height}px`,
    height: `${height}px`,
    zIndex: "9999",
    display: "grid",
    placeItems: "center",
    background: dark ? "#2c2c2e" : "#d1d4da",
    color: dark ? "#8e8e93" : "#6b6b70",
    font: "13px -apple-system, sans-serif",
  });
  document.documentElement.appendChild(box);
  viewport.dispatchEvent(new Event("resize"));
  viewport.dispatchEvent(new Event("scroll"));
}
