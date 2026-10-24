//! A latency histogram in microseconds: 32 sub-buckets per power of two, so a
//! quantile is within about 3 % of the true value and a histogram is a fixed
//! 1184 counters whatever it holds.

use serde::{Deserialize, Serialize};

const SUB: u64 = 32;
const BUCKETS: usize = (SUB as usize) * 37;

#[derive(Debug, Clone)]
pub struct Histogram {
    counts: Vec<u64>,
    total: u64,
    sum: u128,
    max: u64,
}

impl Default for Histogram {
    fn default() -> Self {
        Self::new()
    }
}

fn index(value: u64) -> usize {
    if value < SUB {
        return value as usize;
    }
    let msb = 63 - u64::from(value.leading_zeros());
    let shift = msb - 5;
    let sub = (value >> shift) - SUB;
    let at = SUB + shift * SUB + sub;
    (at as usize).min(BUCKETS - 1)
}

/// The largest value a bucket holds.
fn upper(at: usize) -> u64 {
    let at = at as u64;
    if at < SUB {
        return at;
    }
    let k = at - SUB;
    let shift = k / SUB;
    let sub = k % SUB;
    ((SUB + sub + 1) << shift) - 1
}

impl Histogram {
    pub fn new() -> Self {
        Self {
            counts: vec![0; BUCKETS],
            total: 0,
            sum: 0,
            max: 0,
        }
    }

    pub fn record(&mut self, micros: u64) {
        self.counts[index(micros)] += 1;
        self.total += 1;
        self.sum += u128::from(micros);
        self.max = self.max.max(micros);
    }

    pub fn merge(&mut self, other: &Histogram) {
        for (mine, theirs) in self.counts.iter_mut().zip(&other.counts) {
            *mine += theirs;
        }
        self.total += other.total;
        self.sum += other.sum;
        self.max = self.max.max(other.max);
    }

    pub fn count(&self) -> u64 {
        self.total
    }

    /// The value at quantile `q` (0..=1) in microseconds: the upper edge of
    /// its bucket, never more than the largest value recorded; 0 when empty.
    pub fn quantile(&self, q: f64) -> u64 {
        if self.total == 0 {
            return 0;
        }
        let rank = ((q * self.total as f64).ceil() as u64).clamp(1, self.total);
        let mut seen = 0;
        for (at, count) in self.counts.iter().enumerate() {
            seen += count;
            if seen >= rank {
                return if at == BUCKETS - 1 {
                    self.max
                } else {
                    upper(at).min(self.max)
                };
            }
        }
        self.max
    }

    pub fn summary(&self) -> LatencySummary {
        let ms = |micros: u64| micros as f64 / 1000.0;
        LatencySummary {
            count: self.total,
            p50_ms: ms(self.quantile(0.50)),
            p95_ms: ms(self.quantile(0.95)),
            p99_ms: ms(self.quantile(0.99)),
            max_ms: ms(self.max),
            mean_ms: if self.total == 0 {
                0.0
            } else {
                self.sum as f64 / self.total as f64 / 1000.0
            },
        }
    }
}

/// What a report keeps of a histogram.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LatencySummary {
    pub count: u64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub p99_ms: f64,
    pub max_ms: f64,
    pub mean_ms: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_histogram_answers_zero() {
        let histogram = Histogram::new();
        assert_eq!((histogram.count(), histogram.quantile(0.99)), (0, 0));
        assert_eq!(histogram.summary(), LatencySummary::default());
    }

    #[test]
    fn quantiles_of_a_uniform_run_are_within_four_percent() {
        let mut histogram = Histogram::new();
        for value in 1..=10_000u64 {
            histogram.record(value);
        }
        for (q, expected) in [(0.5, 5_000.0), (0.95, 9_500.0), (0.99, 9_900.0)] {
            let got = histogram.quantile(q) as f64;
            assert!((got - expected).abs() / expected < 0.04, "q{q}: {got}");
        }
        assert_eq!(histogram.quantile(1.0), 10_000);
        assert_eq!(histogram.summary().max_ms, 10.0);
    }

    #[test]
    fn small_values_are_exact_and_huge_ones_do_not_overflow() {
        let mut histogram = Histogram::new();
        histogram.record(7);
        histogram.record(31);
        histogram.record(u64::MAX / 2);
        assert_eq!(histogram.quantile(0.01), 7);
        assert_eq!(histogram.quantile(0.5), 31);
        assert_eq!(histogram.quantile(1.0), u64::MAX / 2);
    }

    #[test]
    fn merging_adds_counts_and_keeps_the_larger_maximum() {
        let (mut a, mut b) = (Histogram::new(), Histogram::new());
        for value in 1..=10 {
            a.record(value * 100_000);
        }
        b.record(900_000);
        a.merge(&b);
        assert_eq!(a.count(), 11);
        assert_eq!(a.summary().max_ms, 1000.0);
    }
}
