export type Entry = { page: string; scroll: number; followed: boolean };

export class History {
  private entries: Entry[] = [];
  private position = -1;

  get current(): Entry | undefined {
    return this.entries[this.position];
  }

  visit(page: string, followed = false): Entry {
    const current = this.current;
    if (current?.page === page) {
      current.followed = followed;
      return current;
    }
    const entry = { page, scroll: 0, followed };
    if (followed && current?.followed) {
      this.entries[this.position] = entry;
    } else {
      this.entries.splice(this.position + 1, Infinity, entry);
      this.position = this.entries.length - 1;
    }
    return entry;
  }

  back(): Entry | undefined {
    if (this.position <= 0) return undefined;
    this.position--;
    return this.current;
  }

  forward(): Entry | undefined {
    if (this.position >= this.entries.length - 1) return undefined;
    this.position++;
    return this.current;
  }
}
