// Pitch tools: read the owner's ten pitches, and add a version (a suggested wording) to one.
// In the app: an agent preparing the owner for a call reads the live pitches; one honing them suggests new wordings.
// Used by: tools.go (catalog).
// Uses: the tracker's pitch use-cases with the agent as actor, internal/app/wire/pitch.go (the HTTP API's JSON).
//
// Adding a version never changes what is live: picking the live version, editing a pitch and
// deleting are the owner's (a passkey tap on the site) and have no tool.

package mcpapi

import (
	"context"

	"github.com/bretperry/hussla/internal/app/wire"
	"github.com/bretperry/hussla/internal/config"
)

func pitchTools() []tool {
	return []tool{
		{
			name: "list_pitches", title: "Read the owner's pitches", route: "GET /api/pitches", readOnly: true,
			description: "The owner's pitches (short answers to say out loud: who I am, why now …), each with its title, when to use it, " +
				"the live version and every earlier version.",
			schema: object(nil, props{}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				if err := onlyKeys(args); err != nil {
					return nil, err
				}
				list, err := env.tracker.ListPitches(ctx)
				if err != nil {
					return nil, err
				}
				return wire.PitchList(list), nil
			},
		},
		{
			name: "add_pitch_version", title: "Suggest a new wording for a pitch", route: "POST /api/pitches/{slot}/versions", idempotent: true,
			description: "Add a version to one of the owner's pitches. It goes into the pitch's history; the owner compares it and decides " +
				"whether it goes live. Keep it sayable, under the character limit list_pitches reports. Say why in note.",
			schema: object([]string{"slot", "text"}, props{
				"slot": props{"type": "integer", "minimum": 1, "maximum": config.PitchSlots, "description": "which pitch (its slot in list_pitches)"},
				"text": str("the new wording, plain text"),
				"note": str("what changed and why, in a few words"),
			}),
			run: func(ctx context.Context, env *callEnv, args wire.Object) (any, error) {
				if err := onlyKeys(args, "slot", "text", "note"); err != nil {
					return nil, err
				}
				slot, err := wholeNumber(args, "slot")
				if err != nil {
					return nil, err
				}
				draft, err := wire.DecodePitchDraft(without(args, "slot"))
				if err != nil {
					return nil, err
				}
				pitch, _, err := env.tracker.AddPitchVersion(ctx, env.trackerActor(), slot, draft)
				if err != nil {
					return nil, err
				}
				return wire.PitchObject(pitch), nil
			},
		},
	}
}

// wholeNumber reads a required whole-number argument (agents send 3 or 3.0).
func wholeNumber(args wire.Object, key string) (int, error) {
	value, present := args[key]
	if !present || string(value) == "null" {
		return 0, invalid(key, "is required")
	}
	number, ok := wire.WholeNumber(value)
	if !ok {
		return 0, invalid(key, "must be a whole number")
	}
	return number, nil
}
