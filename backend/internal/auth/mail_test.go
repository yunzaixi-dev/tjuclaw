package auth

import (
	"bytes"
	"html/template"
	"path/filepath"
	"strings"
	"testing"
)

func TestMailTemplatesUseRealCodeVariables(t *testing.T) {
	for _, kind := range []string{"login", "registration", "verification"} {
		for _, format := range []string{"txt", "html"} {
			path := filepath.Join("..", "..", "..", "ops", "auth", "mail", kind+"."+format+".gotmpl")
			tmpl, err := template.ParseFiles(path)
			if err != nil {
				t.Fatal(err)
			}
			data := map[string]any{"ExpiresInMinutes": 10}
			data[strings.ToUpper(kind[:1])+kind[1:]+"Code"] = "123456"
			var out bytes.Buffer
			if err := tmpl.Option("missingkey=error").Execute(&out, data); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(out.String(), "123456") || !strings.Contains(out.String(), "10") {
				t.Fatal("template lost its code or expiry")
			}
		}
	}
}
