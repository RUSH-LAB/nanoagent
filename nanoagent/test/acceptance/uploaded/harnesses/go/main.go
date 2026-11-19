// A harness with zero model calls: computes the probe's digest locally and writes the result atomically.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"

	"github.com/tidwall/gjson"
)

func main() {
	request, err := os.ReadFile(os.Getenv("RUSH_REQUEST"))
	if err != nil {
		panic(err)
	}
	token := gjson.GetBytes(request, "case.arguments.token").String()
	sum := sha256.Sum256([]byte(token))
	result, _ := json.Marshal(map[string]any{
		"protocol": "rush.harness.v1", "status": "answered", "answer": map[string]string{"digest": hex.EncodeToString(sum[:])[:12]},
	})
	target := os.Getenv("RUSH_RESULT")
	if err := os.WriteFile(target+".tmp", result, 0o644); err != nil {
		panic(err)
	}
	if err := os.Rename(target+".tmp", target); err != nil {
		panic(err)
	}
}
