package domain

import "strings"

// Pricing derives USD cost from a token count. AILog.tokens is a single combined
// input+output total (there is no split column), so cost uses ONE blended rate
// per model family rather than separate input/output prices.
//
// Default rates are the midpoint of Anthropic's published list prices (USD/MTok):
//
//	model              input   output   blended (avg = default)
//	claude-haiku-4-5     1.00     5.00     3.00   (STARTER plan)
//	claude-sonnet-4-6    3.00    15.00     9.00   (PRO plan)
//	claude-opus-4-8      5.00    25.00    15.00   (MAX plan)
//	claude-fable-5      10.00    50.00    30.00
//
// These are estimates for an internal KPI dashboard — override per deployment.
// Matching is by family substring so model-id drift (date suffixes, minor
// version bumps) keeps resolving without code changes.
type familyRate struct {
	family string
	rate   float64
}

type Pricing struct {
	// families is ordered most-expensive-first, so a model id that happens to
	// match more than one family (e.g. an alias containing two tokens like
	// "sonnet-haiku") resolves DETERMINISTICALLY to the higher rate —
	// conservative for cost, and independent of map iteration order.
	families []familyRate
	fallback float64
}

// DefaultPricing returns the built-in blended price table.
func DefaultPricing() Pricing {
	return Pricing{
		families: []familyRate{
			{"fable", 30.00},
			{"opus", 15.00},
			{"sonnet", 9.00},
			{"haiku", 3.00},
		},
		fallback: 9.00, // unknown model → assume Sonnet-class; reported in UnknownModels
	}
}

// rateFor resolves a model id to a blended rate. known is false when no family
// matched and the fallback rate was used. Iteration order is fixed
// (most-expensive-first), so overlapping matches are deterministic.
func (p Pricing) rateFor(model string) (rate float64, known bool) {
	m := strings.ToLower(model)
	for _, f := range p.families {
		if strings.Contains(m, f.family) {
			return f.rate, true
		}
	}
	return p.fallback, false
}

// CostUSD returns the estimated cost for `tokens` total tokens of `model`, and
// whether the model's price was known. tokens <= 0 yields 0 cost.
func (p Pricing) CostUSD(model string, tokens int) (cost float64, known bool) {
	rate, known := p.rateFor(model)
	if tokens <= 0 {
		return 0, known
	}
	return float64(tokens) / 1_000_000 * rate, known
}
