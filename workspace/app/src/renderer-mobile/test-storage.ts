// localStorage for the phone app's tests, which run in Node.

export class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  // Throws on a setItem that would take the origin past this many characters, keys
  // and values together, as a full localStorage does.
  quota = Infinity;

  used(): number {
    let n = 0;
    for (const [key, value] of this.items) n += key.length + value.length;
    return n;
  }

  get length() {
    return this.items.size;
  }

  clear() {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.items.delete(key);
  }

  setItem(key: string, value: string) {
    const old = this.items.get(key);
    const after = this.used() - (old === undefined ? 0 : key.length + old.length) + key.length + value.length;
    if (after > this.quota) throw new Error("QuotaExceededError");
    this.items.set(key, value);
  }
}
