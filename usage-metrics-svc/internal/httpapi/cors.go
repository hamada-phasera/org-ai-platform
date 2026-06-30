package httpapi

import "net/http"

// CORS wraps a handler with configurable CORS headers so a browser SPA (the
// dashboard panel) can call the API cross-origin. allowOrigin defaults to "*"
// when empty; set CORS_ALLOW_ORIGIN to lock it to a specific origin in prod.
func CORS(allowOrigin string) func(http.Handler) http.Handler {
	if allowOrigin == "" {
		allowOrigin = "*"
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Origin", allowOrigin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
