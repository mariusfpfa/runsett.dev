export interface RegisteredModule {
  moduleId: string;
  moduleHash: string;
  /** Absolute path inside the immutable image, never supplied by the invocation. */
  path: string;
  /** Local content-addressed image ID or repository@sha256 digest. Mutable tags are forbidden. */
  image: string;
}
export class ModuleRegistry {
  private readonly entries = new Map<string, Readonly<RegisteredModule>>();
  constructor(entries: readonly RegisteredModule[]) {
    for (const entry of entries) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(entry.moduleId) ||
          !/^[a-f0-9]{64}$/.test(entry.moduleHash) ||
          !/^\/opt\/runsett\/modules\/[a-zA-Z0-9_./-]+\.mjs$/.test(entry.path) ||
          entry.path.slice(1).split('/').some(part => part === '..' || part === '.' || part === '') ||
          !/^(?:sha256:|[^\s]+@sha256:)[a-f0-9]{64}$/.test(entry.image)) {
        throw new TypeError('Module registry requires a logical ID, SHA-256, safe image path and immutable image digest');
      }
      if (this.entries.has(entry.moduleId)) throw new TypeError(`Duplicate module ID: ${entry.moduleId}`);
      this.entries.set(entry.moduleId, Object.freeze({ ...entry }));
    }
  }
  resolve(moduleId: string, moduleHash: string): Readonly<RegisteredModule> {
    const entry = this.entries.get(moduleId);
    if (!entry || entry.moduleHash !== moduleHash) throw new TypeError('Unknown module ID or deployment hash mismatch');
    return entry;
  }
}
