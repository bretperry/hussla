# UI tests that mock the API with contract-shaped data never check the server's real answers

`2026-10-09` · from PR #16 (null `reviews`) and `test/contract-responses` · area: `internal/httpapi`, `api/openapi.yaml`

**Symptom:** the front page went blank on the first NAS install ("t.reviews is null"), with every UI and Go test green.
**Cause:** the UI tests feed fixtures shaped like the contract, and the Go tests asserted only the fields they cared about, so nothing compared what the server actually sends with `api/openapi.yaml`. The server answered `null` for never-set lists where the contract promises arrays.
**Do instead:** let the HTTP test rig check every answer: `rig.do` validates each 2xx JSON response against its operation's schema, and a new read route gets an empty-state read.
**Check:** `go test ./internal/httpapi/` (`response_contract_test.go`, `TestEmptyStateReadsMatchTheContract`, which fails when a documented GET isn't read).
