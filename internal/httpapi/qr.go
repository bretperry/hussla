// The QR code for the Hussla address, as an SVG: scanned by the phone's camera in the wizard and on the home-network page.
// In the app: "Scan this with your phone" (GET /api/setup/qr) and the home-network page once Tailscale is running.
// Used by: routes_setup.go, home.go.
// Uses: rsc.io/qr (pure Go, no I/O).
//
// SVG and not PNG: it stays sharp at any size, inlines into the home page without a second
// request, and needs no image code. Black squares are one path, with the four-module quiet zone
// QR readers need.

package httpapi

import (
	"fmt"
	"html"
	"strings"

	"rsc.io/qr"
)

// qrQuietZone is the blank border, in modules, the QR spec asks for.
const qrQuietZone = 4

func qrSVG(text string) (string, error) {
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return "", fmt.Errorf("qr code: %w", err)
	}
	side := code.Size + 2*qrQuietZone
	var builder strings.Builder
	fmt.Fprintf(&builder, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges" role="img" aria-label="QR code for %s">`, side, side, html.EscapeString(text))
	fmt.Fprintf(&builder, `<rect width="%d" height="%d" fill="#ffffff"/><path fill="#000000" d="`, side, side)
	for y := range code.Size {
		for x := range code.Size {
			if code.Black(x, y) {
				fmt.Fprintf(&builder, "M%d %dh1v1h-1z", x+qrQuietZone, y+qrQuietZone)
			}
		}
	}
	builder.WriteString(`"/></svg>`)
	return builder.String(), nil
}
