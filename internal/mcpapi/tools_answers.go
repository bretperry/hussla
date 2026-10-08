// Answers and settings tools: read saved form answers, ask for a missing one, read the search settings.
// In the app: how an application agent fills a form without guessing, and learns whether it may write at all.
// Used by: tools.go (catalog).
// Uses: the tracker use-case with the agent as actor.
//
// get_search_config is read-only. Changing settings is the owner's (a passkey tap) and has no tool.

package mcpapi

import (
	"context"

	"github.com/bretperry/hussla/internal/app/wire"
)

func answerTools() []tool {
	return []tool{
		{
			name: "list_answers", title: "Read saved answers", route: "GET /api/answers", readOnly: true,
			description: "The owner's saved answers to application-form questions. Use them verbatim. An entry with no answer is a question waiting on the owner.",
			schema:      object(nil, props{}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				if err := onlyKeys(args); err != nil {
					return nil, err
				}
				list, err := env.tracker.ListAnswers(ctx)
				if err != nil {
					return nil, err
				}
				encoded := make([]wire.Object, 0, len(list))
				for _, answer := range list {
					encoded = append(encoded, answerJSON(answer))
				}
				return map[string]any{"answers": encoded}, nil
			},
		},
		{
			name: "ask_for_answer", title: "Ask the owner a form question", route: "POST /api/answers", idempotent: true,
			description: "When a form asks something with no saved answer, record the question here (no answer) with the jobs that need it, set the job to waiting, and move on. " +
				"Don't guess. You can also pass answer to suggest one; the owner reviews it.",
			schema: object([]string{"question"}, props{
				"question": str("the question exactly as the form words it"), "answer": str("only if you are sure"), "jobIds": strList("jobs that need the answer"),
			}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				if err := onlyKeys(args, "question", "answer", "jobIds"); err != nil {
					return nil, err
				}
				if _, err := text(args, "question", true); err != nil {
					return nil, err
				}
				decoder := &wire.Decoder{}
				patch, err := decoder.DecodeAnswerPatch(args)
				if err != nil {
					return nil, err
				}
				answer, _, err := env.tracker.SaveAnswer(ctx, env.trackerActor(), "", patch)
				if err != nil {
					return nil, err
				}
				return answerJSON(answer), nil
			},
		},
		{
			name: "get_search_config", title: "Read the search settings", route: "GET /api/config", readOnly: true,
			description: "The owner's search settings. If paused is true, only read: change nothing.",
			schema:      object(nil, props{}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				if err := onlyKeys(args); err != nil {
					return nil, err
				}
				settings, err := env.tracker.SearchConfig(ctx)
				if err != nil {
					return nil, err //nolint:wrapcheck // mapped by describe
				}
				return settings, nil
			},
		},
	}
}
