// The secretary bar's layout in WebKit, against the running harness (epic
// secretary-bar), where the component tests (markup only) can't look:
//   - on a short screen (an iPhone on its side, 844 × 390) the folded bar keeps its
//     height and never runs over a permission card, whose every answer can still be
//     reached, folded or with the panel open; and with the panel open over a working
//     session with a draft of several lines, Send stays on screen, and with the
//     keyboard up both Sends stay above it, whichever box has the focus;
//   - on the terminal screen, with the keyboard up, moving the focus from the input
//     line to the bar's reply box keeps the screen above the keyboard.
//   node scripts/mobile-harness/layout-check.ts --control <control url> [--shots <dir>]
// Turns Secretary Mode on and starts scenarios over, paused. Exits 1 when a check fails.

import { devices, webkit, type Page } from "playwright";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const control = option("control") ?? process.env.HARNESS_CONTROL;
if (!control) {
  console.error("usage: node scripts/mobile-harness/layout-check.ts --control <control url> [--shots <dir>]");
  process.exit(2);
}
const shots = option("shots");
const KEYBOARD = 336;

let failed = 0;
function check(name: string, ok: boolean, detail: unknown = "") {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `: ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}

const post = async (path: string) => {
  const res = await fetch(`${control}/${path}`, { method: "POST" });
  if (!res.ok) throw new Error(`${path}: ${await res.text()}`);
};
const { url } = (await (await fetch(`${control}/pair`)).json()) as { url: string };

// The bar's folded line, the bar and the dialog's card, and whether each answer can be
// brought into view and tapped (the point at its centre is the button).
async function measure(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      const r = el?.getBoundingClientRect();
      return r ? { top: r.top, bottom: r.bottom, height: r.height } : null;
    };
    const dock = document.querySelector(".session-screen .dialog-slot.dock");
    const answers = [...(dock?.querySelectorAll<HTMLElement>(".btn") ?? [])].map((button) => {
      button.scrollIntoView({ block: "nearest" });
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { label: button.textContent?.trim(), reachable: !!hit && button.contains(hit) };
    });
    return {
      bar: box(document.querySelector(".session-screen .sbar")),
      line: box(document.querySelector(".session-screen .sbar-line")),
      panel: box(document.querySelector(".session-screen .sbar-panel")),
      dock: box(dock),
      answers,
    };
  });
}

function checkShort(what: string, m: Awaited<ReturnType<typeof measure>>) {
  if (!m.bar || !m.line || !m.dock) return check(`${what}: bar, line and card are on screen`, false, m);
  check(`${what}: the bar keeps its folded line's height`, m.bar.height + 0.5 >= m.line.height + 1, m);
  check(`${what}: the bar ends above the card`, m.bar.bottom <= m.dock.top + 0.5 && m.line.bottom <= m.dock.top + 0.5, m);
  check(`${what}: every answer can be reached`, m.answers.length >= 3 && m.answers.every((a) => a.reachable), m.answers);
}

const browser = await webkit.launch();
try {
  await post("secretary/on");

  // A permission card with a two-line command, on a phone on its side.
  await post("scenario/permission?live=0");
  {
    const context = await browser.newContext({
      ...devices["iPhone 15 Pro landscape"],
      viewport: { width: 844, height: 390 },
      colorScheme: "dark",
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(() => (location.hash = "#/s/multi-code"));
    await page.locator(".session-screen .dialog-slot.dock .btn").first().waitFor();
    await page.locator(".session-screen .sbar-line").waitFor();
    checkShort("short screen, folded", await measure(page));
    if (shots) await page.screenshot({ path: `${shots}/short-folded.png` });
    await page.locator(".session-screen .sbar-say").tap();
    await page.locator(".session-screen .sbar-panel").waitFor();
    checkShort("short screen, panel open", await measure(page));
    if (shots) await page.screenshot({ path: `${shots}/short-open.png` });
    await context.close();
  }

  // A working session on the same short screen, the panel open and a draft of
  // several lines in the compose box: the panel gives way, Send stays on screen.
  await post("scenario/home?live=0");
  {
    const context = await browser.newContext({
      ...devices["iPhone 15 Pro landscape"],
      viewport: { width: 844, height: 390 },
    });
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(() => (location.hash = "#/s/customer-portal"));
    const screen = page.locator(".session-screen");
    await screen.locator(".session-foot .compose textarea").waitFor();
    await screen.locator(".session-foot .compose textarea").fill("First line\nSecond line\nThird line\nFourth line");
    await screen.locator(".sbar-say").tap();
    await screen.locator(".sbar-panel").waitFor();
    // Let the panel's opening settle before measuring.
    await page.waitForTimeout(500);
    // The compose box's Send (the panel's reply box has one of its own), and the reply
    // box's, which the panel scrolls to.
    const sends = await page.evaluate(() => {
      const at = (selector: string, scroll: boolean) => {
        const button = document.querySelector<HTMLElement>(selector)!;
        if (scroll) button.scrollIntoView({ block: "nearest" });
        const r = button.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { top: r.top, bottom: r.bottom, viewport: window.innerHeight, hittable: !!hit && button.contains(hit) };
      };
      return {
        compose: at(".session-screen .session-foot .compose .send", false),
        reply: at(".session-screen .sbar-reply .send", true),
      };
    });
    const onScreen = (s: { bottom: number; viewport: number; hittable: boolean }) => s.bottom <= s.viewport + 0.5 && s.hittable;
    check("short screen, working, panel open: the compose box's Send stays on screen", onScreen(sends.compose), sends.compose);
    check("short screen, working, panel open: the panel scrolls to its reply box's Send", onScreen(sends.reply), sends.reply);
    if (shots) await page.screenshot({ path: `${shots}/short-compose-open.png` });
    await context.close();
  }

  // The same with the keyboard up: the panel open over a working session, a draft of
  // several lines, the focus in the compose box and then in the panel's reply box.
  // Both Sends stay above the keyboard.
  await post("scenario/home?live=0");
  {
    const context = await browser.newContext({ ...devices["iPhone 15 Pro"], viewport: { width: 393, height: 852 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(() => (location.hash = "#/s/customer-portal"));
    const screen = page.locator(".session-screen");
    const compose = screen.locator(".session-foot .compose textarea");
    await compose.waitFor();
    await screen.locator(".sbar-say").tap();
    await screen.locator(".sbar-panel").waitFor();
    await page.evaluate((height) => {
      const viewport = window.visualViewport!;
      const full = window.innerHeight;
      Object.defineProperty(viewport, "height", { configurable: true, get: () => full - height });
      Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => 0 });
    }, KEYBOARD);
    const resize = () => page.evaluate(() => window.visualViewport!.dispatchEvent(new Event("resize")));
    const sendsAbove = () =>
      page.evaluate(() => {
        const above = window.visualViewport!.height;
        const at = (selector: string, scroll: boolean) => {
          const button = document.querySelector<HTMLElement>(selector)!;
          if (scroll) button.scrollIntoView({ block: "nearest" });
          const r = button.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { top: r.top, bottom: r.bottom, above, hittable: !!hit && button.contains(hit) };
        };
        return {
          typing: document.querySelector(".session-screen")!.classList.contains("typing"),
          compose: at(".session-screen .session-foot .compose .send", false),
          reply: at(".session-screen .sbar-reply .send", true),
        };
      });
    const ok = (s: { bottom: number; above: number; hittable: boolean }) => s.bottom <= s.above + 0.5 && s.hittable;

    await compose.focus();
    await compose.fill("First line\nSecond line\nThird line\nFourth line");
    await resize();
    await page.waitForTimeout(100);
    let f = await sendsAbove();
    check("keyboard up, typing in the compose box: its Send stays above the keyboard", f.typing && ok(f.compose), f);
    await screen.locator(".sbar-reply textarea").focus();
    await resize();
    await page.waitForTimeout(100);
    f = await sendsAbove();
    check("keyboard up, typing in the reply box: both Sends stay above the keyboard", f.typing && ok(f.reply) && ok(f.compose), f);
    if (shots) await page.screenshot({ path: `${shots}/keyboard-compose-panel.png` });
    await context.close();
  }

  // The terminal, the keyboard up: from the input line to the reply box.
  await post("scenario/home?live=0");
  {
    const context = await browser.newContext({ ...devices["iPhone 15 Pro"], viewport: { width: 393, height: 852 } });
    const page = await context.newPage();
    await page.goto(url);
    await page.evaluate(() => (location.hash = "#/s/multi-code/term"));
    const screen = page.locator(".terminal-screen:not([hidden])");
    await screen.locator(".tinput input").waitFor();
    await screen.locator(".sbar-say").tap();
    await screen.locator(".sbar-reply textarea").waitFor();
    // The keyboard, as the page sees it: the visual viewport loses its height.
    await page.evaluate((height) => {
      const viewport = window.visualViewport!;
      const full = window.innerHeight;
      Object.defineProperty(viewport, "height", { configurable: true, get: () => full - height });
      Object.defineProperty(viewport, "offsetTop", { configurable: true, get: () => 0 });
    }, KEYBOARD);
    const frame = () =>
      page.evaluate(() => {
        const el = document.querySelector<HTMLElement>(".terminal-screen:not([hidden])")!;
        const foot = el.querySelector(".term-foot")!.getBoundingClientRect();
        const reply = el.querySelector(".sbar-reply textarea")!.getBoundingClientRect();
        return {
          typing: el.classList.contains("typing"),
          height: el.getBoundingClientRect().height,
          footBottom: foot.bottom,
          replyBottom: reply.bottom,
          // What the keyboard leaves.
          above: window.visualViewport!.height,
        };
      });
    const resize = () => page.evaluate(() => window.visualViewport!.dispatchEvent(new Event("resize")));

    await screen.locator(".tinput input").focus();
    await resize();
    let f = await frame();
    check("terminal: the input line keeps the screen above the keyboard", f.typing && f.footBottom <= f.above + 0.5, f);
    await screen.locator(".sbar-reply textarea").focus();
    await resize();
    f = await frame();
    check(
      "terminal: so does the reply box the focus moved to",
      f.typing && f.footBottom <= f.above + 0.5 && f.replyBottom <= f.above + 0.5,
      f
    );
    if (shots) await page.screenshot({ path: `${shots}/terminal-reply-keyboard.png` });
    await context.close();
  }
} finally {
  await browser.close();
}
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
