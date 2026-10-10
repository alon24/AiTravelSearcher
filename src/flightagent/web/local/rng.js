/* Python's random.Random (MT19937) in JS, seeded the way the Python mock provider seeds it (first 8 bytes of a SHA-256),
   so the browser's demo fares are the very same numbers the server's mock provider returns. Only the methods the mock
   uses are here: random, uniform, randint, choice, sample. */
(function (root) {
  "use strict";
  const L = (root.SkyhopLocal = root.SkyhopLocal || {});
  const N = 624, M = 397;

  class PyRandom {
    constructor(key) { this.initByArray(key); }

    initGenrand(s) {
      this.mt = new Uint32Array(N);
      this.mt[0] = s >>> 0;
      for (let i = 1; i < N; i++) {
        const p = this.mt[i - 1] ^ (this.mt[i - 1] >>> 30);
        this.mt[i] = (Math.imul(1812433253, p) + i) >>> 0;
      }
      this.mti = N;
    }

    initByArray(key) {          // CPython's init_by_array: `key` is the seed as little-endian 32-bit words
      this.initGenrand(19650218);
      const mt = this.mt;
      let i = 1, j = 0;
      for (let k = Math.max(N, key.length); k; k--) {
        const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = ((mt[i] ^ Math.imul(p, 1664525)) + key[j] + j) >>> 0;
        i++; j++;
        if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
        if (j >= key.length) j = 0;
      }
      for (let k = N - 1; k; k--) {
        const p = mt[i - 1] ^ (mt[i - 1] >>> 30);
        mt[i] = ((mt[i] ^ Math.imul(p, 1566083941)) - i) >>> 0;
        i++;
        if (i >= N) { mt[0] = mt[N - 1]; i = 1; }
      }
      mt[0] = 0x80000000;
    }

    uint32() {
      const mt = this.mt;
      if (this.mti >= N) {
        for (let k = 0; k < N; k++) {
          const y = (mt[k] & 0x80000000) | (mt[(k + 1) % N] & 0x7fffffff);
          mt[k] = mt[(k + M) % N] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
        }
        this.mti = 0;
      }
      let y = mt[this.mti++];
      y ^= y >>> 11;
      y ^= (y << 7) & 0x9d2c5680;
      y ^= (y << 15) & 0xefc60000;
      y ^= y >>> 18;
      return y >>> 0;
    }

    random() {
      const a = this.uint32() >>> 5, b = this.uint32() >>> 6;
      return (a * 67108864 + b) / 9007199254740992;
    }

    below(n) {                  // _randbelow_with_getrandbits (n < 2**32)
      const k = 32 - Math.clz32(n);
      let r = this.uint32() >>> (32 - k);
      while (r >= n) r = this.uint32() >>> (32 - k);
      return r;
    }

    uniform(a, b) { return a + (b - a) * this.random(); }
    randint(a, b) { return a + this.below(b - a + 1); }
    choice(seq) { return seq[this.below(seq.length)]; }

    sample(population, k) {     // the pool branch: always taken for populations of up to 21 items
      const pool = [...population], n = pool.length, out = [];
      for (let i = 0; i < k; i++) {
        const j = this.below(n - i);
        out.push(pool[j]);
        pool[j] = pool[n - i - 1];
      }
      return out;
    }
  }

  // Python: random.Random(int.from_bytes(sha256("|".join(parts))[:8], "big"))
  async function seeded(...parts) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("|"))));
    const word = i => ((digest[i] << 24) | (digest[i + 1] << 16) | (digest[i + 2] << 8) | digest[i + 3]) >>> 0;
    const hi = word(0), lo = word(4);
    return new PyRandom(hi ? [lo, hi] : [lo]);
  }

  L.rng = { PyRandom, seeded };
  if (typeof module !== "undefined" && module.exports) module.exports = L.rng;
})(typeof window !== "undefined" ? window : globalThis);
