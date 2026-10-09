// Every 2xx JSON answer the rig sees is checked against its operation's response schema in api/openapi.yaml.
// In the app: a null where the contract promises a list, a missing required field or a wrong type fails `go test`, not the UI (the null `reviews` crash).
// Used by: rig.do (harness_test.go), so every test in this package checks the answers it gets.
// Uses: api/openapi.yaml, go.yaml.in/yaml/v3 (to read it), santhosh-tekuri/jsonschema/v6 (OpenAPI 3.1 schemas are JSON Schema 2020-12).
//
// The operation is found by method and path template ("/api/jobs/{jobId}"); a literal segment
// beats a parameter, so "/api/setup/qr" is never taken for a "{slot}"-style template. A 2xx JSON
// answer with no documented operation or status fails too: the contract must say what it is.
// Non-JSON answers (markdown, files, the QR SVG, redirects) aren't checked here.

package httpapi_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"go.yaml.in/yaml/v3"
)

// contractURL names the loaded contract for the schema compiler; it is never fetched.
const contractURL = "file:///api/openapi.json"

// responseContract is api/openapi.yaml, loaded once per test binary.
type responseContract struct {
	document  map[string]any
	templates []string // the documented paths
	compiler  *jsonschema.Compiler
	mutex     sync.Mutex
	compiled  map[string]*jsonschema.Schema // by JSON pointer
}

var (
	loadContractOnce sync.Once
	loadedContract   *responseContract
	errLoadContract  error
)

func theResponseContract() (*responseContract, error) {
	loadContractOnce.Do(func() { loadedContract, errLoadContract = loadResponseContract() })
	return loadedContract, errLoadContract
}

func loadResponseContract() (*responseContract, error) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "api", "openapi.yaml"))
	if err != nil {
		return nil, err
	}
	var fromYAML any
	if err := yaml.Unmarshal(raw, &fromYAML); err != nil {
		return nil, fmt.Errorf("api/openapi.yaml: %w", err)
	}
	// Round-trip through JSON so the compiler sees plain JSON values (json.Number, string keys).
	asJSON, err := json.Marshal(fromYAML)
	if err != nil {
		return nil, fmt.Errorf("api/openapi.yaml as JSON: %w", err)
	}
	document, err := jsonschema.UnmarshalJSON(bytes.NewReader(asJSON))
	if err != nil {
		return nil, err
	}
	root, ok := document.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("api/openapi.yaml is not an object")
	}
	paths, ok := root["paths"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("api/openapi.yaml has no paths")
	}
	compiler := jsonschema.NewCompiler()
	compiler.DefaultDraft(jsonschema.Draft2020)
	if err := compiler.AddResource(contractURL, document); err != nil {
		return nil, err
	}
	contract := &responseContract{document: root, compiler: compiler, compiled: map[string]*jsonschema.Schema{}}
	for template := range paths {
		contract.templates = append(contract.templates, template)
	}
	return contract, nil
}

// template is the documented path a request path falls under ("" when none): every segment
// matches, and among matches the one with the most literal segments wins.
func (contract *responseContract) template(path string) string {
	segments := strings.Split(path, "/")
	best, bestLiterals := "", -1
	for _, template := range contract.templates {
		parts := strings.Split(template, "/")
		if len(parts) != len(segments) {
			continue
		}
		literals, matched := 0, true
		for i, part := range parts {
			if strings.HasPrefix(part, "{") && strings.HasSuffix(part, "}") {
				matched = segments[i] != ""
			} else {
				matched = part == segments[i]
				literals++
			}
			if !matched {
				break
			}
		}
		if matched && literals > bestLiterals {
			best, bestLiterals = template, literals
		}
	}
	return best
}

// lookup follows a JSON pointer ("#/a/b") into the contract.
func (contract *responseContract) lookup(pointer string) (any, bool) {
	var node any = contract.document
	for _, token := range strings.Split(strings.TrimPrefix(pointer, "#/"), "/") {
		object, ok := node.(map[string]any)
		if !ok {
			return nil, false
		}
		node, ok = object[strings.ReplaceAll(strings.ReplaceAll(token, "~1", "/"), "~0", "~")]
		if !ok {
			return nil, false
		}
	}
	return node, true
}

func escapePointer(token string) string {
	return strings.ReplaceAll(strings.ReplaceAll(token, "~", "~0"), "/", "~1")
}

// responseSchema is the compiled schema for one operation's JSON answer at one status, or an
// error saying what the contract lacks.
func (contract *responseContract) responseSchema(method, template string, status int) (*jsonschema.Schema, error) {
	pointer := "#/paths/" + escapePointer(template) + "/" + strings.ToLower(method) + "/responses/" + strconv.Itoa(status)
	response, ok := contract.lookup(pointer)
	if !ok {
		return nil, fmt.Errorf("api/openapi.yaml documents no %d answer for %s %s", status, method, template)
	}
	// A shared response ($ref to #/components/responses/...) is followed to where it is defined.
	if object, isObject := response.(map[string]any); isObject {
		if ref, isRef := object["$ref"].(string); isRef {
			pointer = ref
		}
	}
	pointer += "/content/application~1json/schema"
	if _, ok := contract.lookup(pointer); !ok {
		return nil, fmt.Errorf("api/openapi.yaml has no application/json schema for %s %s %d", method, template, status)
	}
	contract.mutex.Lock()
	defer contract.mutex.Unlock()
	if schema, ok := contract.compiled[pointer]; ok {
		return schema, nil
	}
	schema, err := contract.compiler.Compile(contractURL + pointer)
	if err != nil {
		return nil, fmt.Errorf("compile %s: %w", pointer, err)
	}
	contract.compiled[pointer] = schema
	return schema, nil
}

// checkResponseContract fails the test when a 2xx JSON answer doesn't match the contract.
func checkResponseContract(t *testing.T, method, target string, got reply) {
	t.Helper()
	if got.status < 200 || got.status > 299 {
		return
	}
	mediaType, _, _ := mime.ParseMediaType(got.header.Get("Content-Type"))
	if mediaType != "application/json" {
		return
	}
	contract, err := theResponseContract()
	if err != nil {
		t.Fatalf("load api/openapi.yaml: %v", err)
	}
	path, _, _ := strings.Cut(target, "?")
	template := contract.template(path)
	if template == "" {
		t.Errorf("%s %s answered %d JSON, but api/openapi.yaml documents no such path", method, path, got.status)
		return
	}
	schema, err := contract.responseSchema(method, template, got.status)
	if err != nil {
		t.Errorf("%s %s: %v", method, path, err)
		return
	}
	body, err := jsonschema.UnmarshalJSON(bytes.NewReader(got.body))
	if err != nil {
		t.Errorf("%s %s answered %d with invalid JSON: %v: %s", method, path, got.status, err, got.body)
		return
	}
	if err := schema.Validate(body); err != nil {
		t.Errorf("%s %s answered %d against api/openapi.yaml (%s):\n%v\nbody: %s", method, path, got.status, template, err, got.body)
	}
}
