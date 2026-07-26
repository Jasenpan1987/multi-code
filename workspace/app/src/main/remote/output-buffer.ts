// Keeps a bounded tail of each instance's PTY output so a phone that connects
// mid-session sees the current screen instead of an empty terminal.
//
// This is deliberately dumb: a byte tail, not a parsed screen. Replaying the
// tail into a fresh xterm on the phone reconstructs the visible state, because
// the CLI's TUI repaints on every update and the escape sequences that matter
// (cursor moves, colors, clears) are all inside the window we keep. A real
// server-side terminal emulator would be more precise and much more code; the
// tail is enough for "glance at my phone and see what the agent is doing".

// 256 KB per instance. Large enough to hold several full repaints of a 120x30
// TUI (~40 KB each with color), small enough that a dozen instances stay well
// under a few megabytes.
const MAX_BYTES = 256 * 1024;

class OutputBuffer {
  private buffers = new Map<string, string[]>();
  private sizes = new Map<string, number>();

  append(instanceId: string, data: string) {
    const chunks = this.buffers.get(instanceId) ?? [];
    chunks.push(data);
    let size = (this.sizes.get(instanceId) ?? 0) + data.length;

    // Drop whole chunks from the front until we're back under the cap. Cutting
    // on chunk boundaries can still split a multi-byte escape sequence, so the
    // very first bytes a phone receives may be garbage — xterm resynchronizes on
    // the next control sequence, which arrives within one repaint.
    while (size > MAX_BYTES && chunks.length > 1) {
      const dropped = chunks.shift();
      size -= dropped?.length ?? 0;
    }

    this.buffers.set(instanceId, chunks);
    this.sizes.set(instanceId, size);
  }

  snapshot(instanceId: string): string {
    return (this.buffers.get(instanceId) ?? []).join("");
  }

  clear(instanceId: string) {
    this.buffers.delete(instanceId);
    this.sizes.delete(instanceId);
  }
}

export const outputBuffer = new OutputBuffer();
