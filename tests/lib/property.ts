/**
 * Zero-dependency deterministic property-based testing engine with shrinking.
 * Sealed in Zone A of `proof-lock.json`.
 */

export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  bool(trueProb?: number): boolean;
  pick<T>(items: readonly T[]): T;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min: number, max: number): number {
      return min + Math.floor(next() * (max - min + 1));
    },
    bool(trueProb = 0.5): boolean {
      return next() < trueProb;
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new Error('Cannot pick from an empty array');
      }
      return items[Math.floor(next() * items.length)];
    },
  };
}

export interface Generator<T> {
  readonly sample: (rng: Rng) => T;
  readonly shrink?: (value: T) => readonly T[];
}

export const gen = {
  int(min: number, max: number): Generator<number> {
    return {
      sample: (rng) => rng.int(min, max),
      shrink: (value) => {
        if (value === min) return [];
        const candidates: number[] = [];
        const mid = Math.trunc((value + min) / 2);
        if (mid !== value) candidates.push(mid);
        if (min !== mid) candidates.push(min);
        return candidates;
      },
    };
  },

  bool(trueProb = 0.5): Generator<boolean> {
    return {
      sample: (rng) => rng.bool(trueProb),
      shrink: (value) => (value ? [false] : []),
    };
  },

  oneOf<T>(items: readonly T[]): Generator<T> {
    return {
      sample: (rng) => rng.pick(items),
      shrink: (value) => (value === items[0] ? [] : [items[0]]),
    };
  },

  string(maxLen = 16): Generator<string> {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-_';
    return {
      sample: (rng) => {
        const len = rng.int(0, maxLen);
        let out = '';
        for (let i = 0; i < len; i += 1) {
          out += alphabet[rng.int(0, alphabet.length - 1)];
        }
        return out;
      },
      shrink: (value) => {
        if (value.length === 0) return [];
        return ['', value.slice(0, Math.floor(value.length / 2))];
      },
    };
  },

  array<T>(itemGen: Generator<T>, maxLen = 10): Generator<T[]> {
    return {
      sample: (rng) => {
        const len = rng.int(0, maxLen);
        const arr: T[] = [];
        for (let i = 0; i < len; i += 1) {
          arr.push(itemGen.sample(rng));
        }
        return arr;
      },
      shrink: (value) => {
        if (value.length === 0) return [];
        const candidates: T[][] = [
          [],
          value.slice(0, Math.floor(value.length / 2)),
        ];
        if (value.length > 1) {
          candidates.push(value.slice(1));
          candidates.push(value.slice(0, -1));
        }
        return candidates;
      },
    };
  },
};

export interface PropertyOptions {
  readonly runs?: number;
  readonly seed?: number;
}

export function assertProperty<T>(
  name: string,
  generator: Generator<T>,
  predicate: (value: T) => void,
  options: PropertyOptions = {}
): void {
  const runs = options.runs ?? 150;
  const seed = options.seed ?? 20261121;
  const rng = createRng(seed);

  for (let i = 0; i < runs; i += 1) {
    const sample = generator.sample(rng);
    try {
      predicate(sample);
    } catch (firstErr) {
      let minimal = sample;
      let minimalErr = firstErr;
      if (generator.shrink) {
        let improved = true;
        let depth = 0;
        while (improved && depth < 25) {
          improved = false;
          depth += 1;
          for (const candidate of generator.shrink(minimal)) {
            try {
              predicate(candidate);
            } catch (candidateErr) {
              minimal = candidate;
              minimalErr = candidateErr;
              improved = true;
              break;
            }
          }
        }
      }
      const reason =
        minimalErr instanceof Error ? minimalErr.message : String(minimalErr);
      throw new Error(
        `Property "${name}" failed on run #${i + 1} (seed=${seed}). Minimal counterexample: ${JSON.stringify(minimal)}. Error: ${reason}`
      );
    }
  }
}
