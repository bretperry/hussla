// Job statuses: the ids and their pipeline order, in one list.
// In the app: the status filter, the status picker, and the API's status enum follow this order.
// Used by: internal/domain (JobStatus maps onto it one to one), the HTTP layer's GET /api.

package config

// Job status ids as stored and sent over the API. The prototype's spelling; agents send these.
const (
	StatusReview       = "review"
	StatusQueued       = "queued"
	StatusWaiting      = "waiting"
	StatusApplied      = "applied"
	StatusScreening    = "screening"
	StatusInterviewing = "interviewing"
	StatusOffer        = "offer"
	StatusRejected     = "rejected"
	StatusWithdrawn    = "withdrawn"
	StatusSkipped      = "skipped"
	StatusFiltered     = "filtered"
	StatusFailed       = "failed"
)

// JobStatusOrder is the pipeline order the UI lists statuses in: before applying, in progress, closed.
var JobStatusOrder = []string{
	StatusReview, StatusQueued, StatusWaiting, StatusApplied, StatusScreening, StatusInterviewing,
	StatusOffer, StatusRejected, StatusWithdrawn, StatusSkipped, StatusFiltered, StatusFailed,
}

// NewJobStatus is the status a job gets when it is created without one.
const NewJobStatus = StatusReview
