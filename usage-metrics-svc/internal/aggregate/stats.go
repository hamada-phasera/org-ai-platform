package aggregate

import (
	"math"
	"sort"
)

// meanInt returns the rounded arithmetic mean, or 0 for an empty slice.
func meanInt(xs []int) int {
	if len(xs) == 0 {
		return 0
	}
	sum := 0
	for _, x := range xs {
		sum += x
	}
	return int(math.Round(float64(sum) / float64(len(xs))))
}

// percentileInt returns the p-quantile (p in [0,1]) using the nearest-rank
// method: rank = ceil(p*n), value = sorted[rank-1]. Returns 0 for an empty slice.
// Examples: n=1 → the single value; n=20, p=0.95 → the 19th value.
func percentileInt(xs []int, p float64) int {
	n := len(xs)
	if n == 0 {
		return 0
	}
	s := make([]int, n)
	copy(s, xs)
	sort.Ints(s)
	rank := int(math.Ceil(p * float64(n)))
	if rank < 1 {
		rank = 1
	}
	if rank > n {
		rank = n
	}
	return s[rank-1]
}

// round6 rounds to 6 decimal places so JSON costs don't carry float noise.
func round6(x float64) float64 {
	return math.Round(x*1e6) / 1e6
}
