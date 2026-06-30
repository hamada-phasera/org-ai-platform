package domain

import "testing"

func TestPricingCostUSD(t *testing.T) {
	p := DefaultPricing()
	cases := []struct {
		model     string
		tokens    int
		wantCost  float64
		wantKnown bool
	}{
		{"claude-haiku-4-5", 1_000_000, 3.0, true},
		{"claude-sonnet-4-6", 1_000_000, 9.0, true},
		{"claude-opus-4-8", 1_000_000, 15.0, true},
		{"claude-fable-5", 1_000_000, 30.0, true},
		{"claude-haiku-4-5-20251001", 1_000_000, 3.0, true}, // date-suffixed id still resolves
		{"gpt-4o", 1_000_000, 9.0, false},                   // unknown → fallback, known=false
		{"claude-haiku-4-5", 0, 0, true},                    // zero tokens → zero cost
	}
	for _, c := range cases {
		gotCost, gotKnown := p.CostUSD(c.model, c.tokens)
		if !almostEq(gotCost, c.wantCost) || gotKnown != c.wantKnown {
			t.Errorf("CostUSD(%q,%d) = (%v,%v), want (%v,%v)",
				c.model, c.tokens, gotCost, gotKnown, c.wantCost, c.wantKnown)
		}
	}
}

// TestPricingOverlappingFamilyIsDeterministic pins the previously non-deterministic
// case: a model id containing two family tokens must resolve to a stable rate
// (most-expensive-first → sonnet over haiku), the same on every run.
func TestPricingOverlappingFamilyIsDeterministic(t *testing.T) {
	p := DefaultPricing()
	const id = "sonnet-haiku-experimental"
	first, _ := p.CostUSD(id, 1_000_000)
	if !almostEq(first, 9.0) {
		t.Fatalf("CostUSD(%q) = %v, want 9.0 (sonnet, the higher of the two)", id, first)
	}
	for i := 0; i < 1000; i++ {
		got, _ := p.CostUSD(id, 1_000_000)
		if got != first {
			t.Fatalf("non-deterministic rate for %q: got %v then %v", id, first, got)
		}
	}
}

func almostEq(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 1e-9
}
