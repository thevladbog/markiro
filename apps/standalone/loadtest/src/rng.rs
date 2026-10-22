//! A small seeded generator (SplitMix64): a run with the same seed makes the
//! same payloads, and the crate needs no `rand`.

#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A number in `[0, 1)`.
    pub fn unit(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// `true` with probability `p` (never for 0, always for 1 and more).
    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }

    /// A number in `[low, high)`; `low` when the range is empty.
    pub fn range(&mut self, low: u64, high: u64) -> u64 {
        if high <= low {
            return low;
        }
        low + self.next_u64() % (high - low)
    }

    /// An exponentially distributed number with the given mean.
    pub fn exp(&mut self, mean: f64) -> f64 {
        -mean * (1.0 - self.unit()).ln()
    }

    /// `base` times a factor in `[1 - spread, 1 + spread)`.
    pub fn jitter(&mut self, base: f64, spread: f64) -> f64 {
        base * (1.0 - spread + 2.0 * spread * self.unit())
    }

    /// A lower-case hyphenated version 4 UUID, the form the host accepts.
    pub fn uuid(&mut self) -> String {
        let high = self.next_u64();
        let low = self.next_u64();
        let high = (high & 0xFFFF_FFFF_FFFF_0FFF) | 0x0000_0000_0000_4000;
        let low = (low & 0x3FFF_FFFF_FFFF_FFFF) | 0x8000_0000_0000_0000;
        format!(
            "{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
            high >> 32,
            (high >> 16) & 0xFFFF,
            high & 0xFFFF,
            low >> 48,
            low & 0xFFFF_FFFF_FFFF
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_seed_makes_the_same_numbers() {
        let mut a = Rng::new(7);
        let mut b = Rng::new(7);
        assert_eq!(
            (0..5).map(|_| a.next_u64()).collect::<Vec<_>>(),
            (0..5).map(|_| b.next_u64()).collect::<Vec<_>>()
        );
        assert_ne!(Rng::new(7).next_u64(), Rng::new(8).next_u64());
    }

    #[test]
    fn units_stay_in_range_and_chance_respects_its_bounds() {
        let mut rng = Rng::new(1);
        for _ in 0..10_000 {
            let unit = rng.unit();
            assert!((0.0..1.0).contains(&unit));
        }
        assert!((0..1000).all(|_| !rng.chance(0.0)));
        assert!((0..1000).all(|_| rng.chance(1.0)));
        let hits = (0..100_000).filter(|_| rng.chance(0.25)).count();
        assert!((24_000..26_000).contains(&hits), "{hits}");
    }

    #[test]
    fn a_uuid_is_canonical_and_never_repeats() {
        let mut rng = Rng::new(3);
        let mut seen = std::collections::HashSet::new();
        for _ in 0..1000 {
            let id = rng.uuid();
            assert_eq!(id.len(), 36);
            assert_eq!(&id[14..15], "4");
            assert!(
                matches!(&id[19..20], "8" | "9" | "a" | "b"),
                "the variant nibble of a v4 uuid"
            );
            assert_eq!(id, id.to_lowercase());
            assert!(seen.insert(id));
        }
    }

    #[test]
    fn range_and_exp_behave() {
        let mut rng = Rng::new(9);
        assert_eq!(rng.range(5, 5), 5);
        assert!((0..1000).all(|_| (10..20).contains(&rng.range(10, 20))));
        let mean = (0..50_000).map(|_| rng.exp(4.0)).sum::<f64>() / 50_000.0;
        assert!((3.8..4.2).contains(&mean), "{mean}");
    }
}
